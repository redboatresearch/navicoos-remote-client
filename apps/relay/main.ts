// Entry point: wiring + WebSocket forwarding. Spec §3.5.
//
// Starts an HTTP/WebSocket relay (Deno.serve), drives the RtspClient handshake
// + video loop, applies keyframe gating and RTP-timestamp -> microsecond
// conversion, and forwards AVCC access units to the WebCodecs frontend.
//
// State that was formerly module-global (firstTs, started) is now per-connection
// inside each WebSocket handler closure to support concurrent clients correctly.

import { ControlClient, RtspClient } from "@navicoos/rtsp";
import type { StreamConfig, TouchEvent } from "@navicoos/rtsp";

const IP = Deno.args[0] ?? "192.168.0.1";
// Client MAC used for the remotecontrold AUTH handshake. Overridable via the
// CLIENT_ID env (passed as argv[1] by the s6 run script), like MFD_IP.
const CLIENT_ID = Deno.args[1] ?? "00:11:22:33:44:55";
const RTSP_PORT = 554;
const STREAM_PATH = "/screenmirror";

// NAL unit types to drop before building the AVCC access unit. We send only
// VCL slices (1 non-IDR, 5 IDR) and rely on the out-of-band avcC for the rest:
//   7 SPS, 8 PPS — sent out-of-band in the config message (avcC `description`).
//   9 AUD        — access-unit delimiter; redundant once we frame per-AU.
//   12 filler    — pure 0xFF padding. ffmpeg/Firefox ignore it, but Chromium
//                  rejects filler in an AVCC sample with "Decoding error".
//   6 SEI        — the MFD emits an SEI on every AU. ffmpeg and Firefox skip
//                  ones they don't understand; Chromium's parser is stricter
//                  and errors. None of it is needed for keyframe-gated playback.
const FILTER_NAL_TYPES = new Set([6, 7, 8, 9, 12]);

/** Convert RTP timestamp to microseconds, anchored to the first timestamp seen on this connection. */
function makeToMicros(): (rtpTs: number, clockRate: number) => number {
  let firstTs: number | null = null;
  return (rtpTs: number, clockRate: number): number => {
    if (firstTs === null) firstTs = rtpTs;
    const delta = (rtpTs - firstTs) >>> 0; // unsigned 32-bit wrap
    return Math.round((delta * 1_000_000) / clockRate);
  };
}

/**
 * Build an AVCC access unit from raw NALs.
 * Drops SPS/PPS/AUD (types 7/8/9) — those are sent out-of-band in the config message.
 * Each remaining NAL is prefixed with a 4-byte big-endian length (AVCC, not Annex-B).
 */
function buildAvccAu(nals: Uint8Array[]): Uint8Array {
  const filtered = nals.filter((nal) => !FILTER_NAL_TYPES.has(nal[0] & 0x1f));
  if (filtered.length === 0) return new Uint8Array(0);

  const totalLen = filtered.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  let offset = 0;
  for (const nal of filtered) {
    dv.setUint32(offset, nal.length, false); // big-endian length prefix
    offset += 4;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}

/** Build the 9-byte header + AVCC AU binary frame sent to the frontend. */
function frameForClient(au: Uint8Array, isKey: boolean, micros: number): Uint8Array {
  const out = new Uint8Array(9 + au.length);
  out[0] = isKey ? 1 : 0; // bit0 = keyframe flag
  const dv = new DataView(out.buffer);
  dv.setBigUint64(1, BigInt(micros), false); // bytes 1-8: 64-bit big-endian microseconds
  out.set(au, 9);
  return out;
}

/** Serve a static frontend file, reading from alongside this module. */
async function serveFrontend(filename: string, contentType: string): Promise<Response> {
  const filePath = new URL(`./frontend/${filename}`, import.meta.url);
  const body = await Deno.readFile(filePath);
  return new Response(body, { headers: { "Content-Type": contentType } });
}

Deno.serve({ port: 8080 }, (req) => {
  const url = new URL(req.url);

  // --- WebSocket upgrade ---
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const client = new RtspClient(IP, RTSP_PORT, STREAM_PATH);
    // Control connection (remotecontrold). Lazily handshaken alongside video;
    // null until the handshake succeeds, so input is silently dropped if the
    // device's control port is unreachable while video still plays.
    const control = new ControlClient(IP, CLIENT_ID);
    let controlReady = false;

    socket.onopen = async () => {
      // Per-connection state — NOT module globals.
      const toMicros = makeToMicros();
      let started = false;
      // clockRate is set after connect() resolves; onAccessUnit fires only after PLAY
      // which is after connect() returns, so this reference is always populated in time.
      let clockRate = 90000; // H.264 standard default; overwritten immediately after connect()

      try {
        // Register callback BEFORE connecting (stable contract).
        // onAccessUnit fires only after PLAY, which connect() initiates, so clockRate
        // is populated before any callback invocation.
        client.onAccessUnit = (
          nals: Uint8Array[],
          meta: { marker: boolean; timestamp: number; isKeyframe: boolean },
        ) => {
          // Keyframe gate: drop AUs until the first IDR, then latch.
          if (!started) {
            if (!meta.isKeyframe) return;
            started = true;
          }
          if (socket.readyState !== WebSocket.OPEN) return;

          const au = buildAvccAu(nals);
          if (au.length === 0) return;

          const micros = toMicros(meta.timestamp, clockRate);
          socket.send(frameForClient(au, meta.isKeyframe, micros));
        };

        // TCP-interleaved over the single control socket.
        // UDP is the lib default but needs --unstable-net; Phase D decides the final default.
        const config: StreamConfig = await client.connect(undefined, { connection: "tcp" });
        clockRate = config.clockRate;

        // Send codec config FIRST so the frontend can configure its VideoDecoder.
        socket.send(JSON.stringify({
          type: "config",
          codec: config.codecString,
          sps: Array.from(config.sps),
          pps: Array.from(config.pps),
        }));
      } catch (err) {
        console.error("[relay] connection error:", err);
        socket.close(1011, "relay error");
        return;
      }

      // Open the control channel independently — a control failure must not
      // take down the (already working) video. On success, hand the frontend
      // the device's button table + coded resolution for coord mapping.
      try {
        await control.connect();
        controlReady = true;
        socket.send(JSON.stringify({
          type: "control",
          buttons: control.buttons,
          width: control.info.width,
          height: control.info.height,
        }));
        console.log(
          `[relay] control ready: ${control.info.name} (${control.info.model}), ` +
            `${control.buttons.length} buttons, ${control.info.width}x${control.info.height}`,
        );
      } catch (err) {
        console.error("[relay] control connect failed (video unaffected):", err);
      }
    };

    // Browser -> relay control messages: forward touch/key to the device.
    socket.onmessage = (ev) => {
      if (!controlReady || typeof ev.data !== "string") return;
      let msg: { t?: string; x?: number; y?: number; e?: number; label?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
        if (msg.t === "touch" && typeof msg.x === "number" && typeof msg.y === "number") {
          control.sendTouch(msg.x, msg.y, (msg.e ?? 0) as TouchEvent);
        } else if (msg.t === "key" && typeof msg.label === "string") {
          control.pressButton(msg.label);
        }
      } catch (err) {
        console.error("[relay] control send failed:", err);
      }
    };

    socket.onclose = () => {
      client.close();
      control.close();
    };
    return response;
  }

  // --- Static frontend ---
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveFrontend("index.html", "text/html");
  }
  if (url.pathname === "/decoder.js") {
    return serveFrontend("decoder.js", "text/javascript");
  }
  if (url.pathname === "/control.js") {
    return serveFrontend("control.js", "text/javascript");
  }

  return new Response("not found", { status: 404 });
});
