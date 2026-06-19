// Entry point: wiring + WebSocket forwarding. Spec §3.5.
//
// Starts an HTTP/WebSocket relay (Deno.serve), drives the RtspClient handshake
// + video loop, applies keyframe gating and RTP-timestamp -> microsecond
// conversion, and forwards AVCC access units to the WebCodecs frontend.

import { RtspClient } from "./rtsp_client.ts";

const IP = Deno.args[0] ?? "192.168.0.1";
const RTSP_PORT = 554;
const STREAM_PATH = "/screenmirror";

let firstTs: number | null = null;
let started = false;

function toMicros(rtpTs: number, clockRate: number): number {
  if (firstTs === null) firstTs = rtpTs;
  const delta = (rtpTs - firstTs) >>> 0; // unsigned 32-bit wrap
  return Math.round((delta * 1_000_000) / clockRate);
}

function frameForClient(au: Uint8Array, isKey: boolean, micros: number): Uint8Array {
  const out = new Uint8Array(9 + au.length);
  out[0] = isKey ? 1 : 0;
  const dv = new DataView(out.buffer);
  dv.setBigUint64(1, BigInt(micros), false); // big-endian
  out.set(au, 9);
  return out;
}

Deno.serve({ port: 8080 }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("video relay"); // serve the frontend HTML here too
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const client = new RtspClient(IP, RTSP_PORT, STREAM_PATH);

  socket.onopen = async () => {
    await client.connect();
    const config = await client.handshake();

    // Send codec config first so the frontend can configure the decoder.
    socket.send(JSON.stringify({
      type: "config",
      codec: config.codecString,
      sps: Array.from(config.sps),
      pps: Array.from(config.pps),
    }));

    await client.runVideoLoop((au, isKey, rtpTs) => {
      if (!started) {
        if (!isKey) return;
        started = true;
      } // keyframe gate
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(frameForClient(au, isKey, toMicros(rtpTs, config.clockRate)));
    });
  };

  socket.onclose = () => client.close();
  return response;
});
