// RTSP handshake + interleaved read loop. Spec §3.4.
//
// A real request -> read response -> next request state machine:
// OPTIONS -> DESCRIBE -> SETUP -> PLAY, then drives the $-framed interleaved
// binary stream until the connection closes.

import { parseSdp } from "./sdp.ts";
import { parseRtp } from "./rtp.ts";
import { H264Depacketizer } from "./depacketizer.ts";
import type { StreamConfig } from "./types.ts";

const CRLF2 = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

interface RtspResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

export class RtspClient {
  private conn!: Deno.TcpConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  private cseq = 1;
  private session = "";
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  constructor(
    private readonly ip: string,
    private readonly port: number,
    private readonly path: string,
  ) {}

  private get baseUrl() {
    return `rtsp://${this.ip}:${this.port}${this.path}`;
  }

  async connect(): Promise<void> {
    this.conn = await Deno.connect({ hostname: this.ip, port: this.port });
    this.reader = this.conn.readable.getReader();
    this.writer = this.conn.writable.getWriter();
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.buf = append(this.buf, value);
    return true;
  }

  private async send(
    method: string,
    url: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    let req = `${method} ${url} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\n`;
    if (this.session) req += `Session: ${this.session}\r\n`;
    for (const [k, v] of Object.entries(extra)) req += `${k}: ${v}\r\n`;
    req += `\r\n`;
    await this.writer.write(this.enc.encode(req));
  }

  private async readResponse(): Promise<RtspResponse> {
    for (;;) {
      const headEnd = indexOf(this.buf, CRLF2);
      if (headEnd !== -1) {
        const headText = this.dec.decode(this.buf.subarray(0, headEnd));
        const lines = headText.split(/\r?\n/);
        const status = parseInt(lines[0].split(/\s+/)[1] ?? "0", 10);
        const headers = new Map<string, string>();
        for (const l of lines.slice(1)) {
          const i = l.indexOf(":");
          if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
        }
        const len = parseInt(headers.get("content-length") ?? "0", 10);
        const bodyStart = headEnd + 4;
        if (this.buf.length >= bodyStart + len) {
          const body = this.buf.slice(bodyStart, bodyStart + len);
          this.buf = this.buf.slice(bodyStart + len);
          return { status, headers, body };
        }
      }
      if (!await this.fill()) throw new Error("connection closed during handshake");
    }
  }

  async handshake(): Promise<StreamConfig> {
    await this.send("OPTIONS", this.baseUrl);
    if ((await this.readResponse()).status !== 200) throw new Error("OPTIONS failed");

    await this.send("DESCRIBE", this.baseUrl, { Accept: "application/sdp" });
    const desc = await this.readResponse();
    if (desc.status !== 200) throw new Error(`DESCRIBE failed (${desc.status})`);
    const config = parseSdp(this.dec.decode(desc.body), this.baseUrl);

    await this.send("SETUP", config.controlUrl, {
      Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
    });
    const setup = await this.readResponse();
    if (setup.status !== 200) {
      // The device refused interleaving — fall back to the UDP transport here.
      throw new Error(`SETUP failed (${setup.status}); device may be UDP-only`);
    }
    this.session = (setup.headers.get("session") ?? "").split(";")[0].trim();

    await this.send("PLAY", this.baseUrl);
    if ((await this.readResponse()).status !== 200) throw new Error("PLAY failed");

    return config;
  }

  // Drives the interleaved binary stream until the connection closes.
  async runVideoLoop(
    onAccessUnit: (au: Uint8Array, isKeyframe: boolean, rtpTs: number) => void,
  ): Promise<void> {
    const depack = new H264Depacketizer(onAccessUnit);

    for (;;) {
      while (this.buf.length < 4) if (!await this.fill()) return;

      // Tolerate stray RTSP text frames (e.g. a keepalive response) between $-frames.
      if (this.buf[0] !== 0x24) {
        const nl = indexOf(this.buf, new Uint8Array([0x0d, 0x0a]));
        if (nl === -1) {
          if (!await this.fill()) return;
          continue;
        }
        this.buf = this.buf.slice(nl + 2);
        continue;
      }

      const channel = this.buf[1];
      const len = (this.buf[2] << 8) | this.buf[3];
      while (this.buf.length < 4 + len) if (!await this.fill()) return;

      const packet = this.buf.subarray(4, 4 + len);
      if (channel === 0) { // RTP video; channel 1 is RTCP
        const { marker, timestamp, payload } = parseRtp(packet);
        depack.push(payload, marker, timestamp);
      }
      this.buf = this.buf.slice(4 + len);
    }
  }

  async close(): Promise<void> {
    try {
      if (this.session) await this.send("TEARDOWN", this.baseUrl);
    } catch { /* ignore */ }
    try {
      this.conn?.close();
    } catch { /* ignore */ }
  }
}
