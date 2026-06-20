// Shared RTSP/RTP helpers for the verification probes.
//
// These probes are intentionally SELF-CONTAINED: they inline the minimal RTSP
// handshake and RTP header parsing rather than importing the (still-stubbed)
// src/ modules, so their output is trustworthy independent of the
// implementation under test. The RTP parsing here mirrors spec §3.1 exactly, so
// running the probes also doubles as a sanity check on that logic.

const CRLF2 = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

export interface ProbeTarget {
  ip: string;
  port: number;
  path: string;
}

export function parseArgs(args: string[]): ProbeTarget & { rest: string[] } {
  const positional = args.filter((a) => !a.startsWith("--"));
  const rest = args.filter((a) => a.startsWith("--"));
  return {
    ip: positional[0] ?? "192.168.0.1",
    port: Number(positional[1] ?? 554),
    path: positional[2] ?? "/screenmirror",
    rest,
  };
}

export interface RtspResponse {
  status: number;
  reason: string;
  headers: Map<string, string>;
  body: Uint8Array;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * A thin RTSP connection that exposes the raw accumulating buffer so the stream
 * probe can switch from text responses into the binary `$`-framed loop without
 * dropping bytes at the boundary (the exact concern called out in spec §3.4).
 */
export class RtspConn {
  private conn!: Deno.TcpConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private cseq = 1;
  session = "";
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  constructor(private readonly target: ProbeTarget) {}

  get baseUrl(): string {
    return `rtsp://${this.target.ip}:${this.target.port}${this.target.path}`;
  }

  async connect(): Promise<void> {
    this.conn = await Deno.connect({ hostname: this.target.ip, port: this.target.port });
    this.reader = this.conn.readable.getReader();
    this.writer = this.conn.writable.getWriter();
  }

  async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    if (value) this.buf = append(this.buf, value);
    return true;
  }

  async send(
    method: string,
    url: string,
    extra: Record<string, string> = {},
  ): Promise<string> {
    let req = `${method} ${url} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\n`;
    if (this.session) req += `Session: ${this.session}\r\n`;
    for (const [k, v] of Object.entries(extra)) req += `${k}: ${v}\r\n`;
    req += `\r\n`;
    await this.writer.write(this.enc.encode(req));
    return req;
  }

  async readResponse(): Promise<RtspResponse> {
    for (;;) {
      const headEnd = indexOf(this.buf, CRLF2);
      if (headEnd !== -1) {
        const headText = this.dec.decode(this.buf.subarray(0, headEnd));
        const lines = headText.split(/\r?\n/);
        const statusParts = lines[0].split(/\s+/);
        const status = parseInt(statusParts[1] ?? "0", 10);
        const reason = statusParts.slice(2).join(" ");
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
          return { status, reason, headers, body };
        }
      }
      if (!await this.fill()) throw new Error("connection closed during handshake");
    }
  }

  decode(b: Uint8Array): string {
    return this.dec.decode(b);
  }

  close(): void {
    try {
      this.conn?.close();
    } catch { /* ignore */ }
  }
}

// --- RTP header parsing (mirrors spec §3.1) ---

export interface RtpPacket {
  payloadType: number;
  marker: boolean;
  seq: number;
  timestamp: number; // 32-bit unsigned
  payload: Uint8Array;
}

export function parseRtp(packet: Uint8Array): RtpPacket {
  const b0 = packet[0];
  const cc = b0 & 0x0f;
  const hasExt = (b0 & 0x10) !== 0;
  const hasPad = (b0 & 0x20) !== 0;
  const b1 = packet[1];
  const marker = (b1 & 0x80) !== 0;
  const payloadType = b1 & 0x7f;
  const seq = (packet[2] << 8) | packet[3];
  const timestamp = ((packet[4] << 24) | (packet[5] << 16) | (packet[6] << 8) | packet[7]) >>> 0;

  let offset = 12 + cc * 4;
  if (hasExt) {
    const extWords = (packet[offset + 2] << 8) | packet[offset + 3];
    offset += 4 + extWords * 4;
  }
  let end = packet.length;
  if (hasPad) end -= packet[packet.length - 1];

  return { payloadType, marker, seq, timestamp, payload: packet.subarray(offset, end) };
}

// --- small formatting helpers ---

export function hex(b: Uint8Array, max = b.length): string {
  return Array.from(b.subarray(0, max), (x) => x.toString(16).padStart(2, "0")).join(" ");
}

export function nalTypeName(t: number): string {
  const names: Record<number, string> = {
    1: "non-IDR slice",
    5: "IDR slice (keyframe)",
    6: "SEI",
    7: "SPS",
    8: "PPS",
    9: "AUD",
    24: "STAP-A",
    25: "STAP-B",
    26: "MTAP16",
    27: "MTAP24",
    28: "FU-A",
    29: "FU-B",
  };
  return names[t] ?? `type ${t}`;
}
