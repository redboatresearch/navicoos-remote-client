// Entry point: wiring + WebSocket forwarding. Spec §3.5.
//
// TODO: implement per spec §3.5 — start an HTTP/WebSocket relay (Deno.serve),
// drive the RtspClient handshake + video loop, apply keyframe gating and
// RTP-timestamp -> microsecond conversion, and forward AVCC access units to the
// WebCodecs frontend.

const IP = Deno.args[0] ?? "192.168.0.1";
const RTSP_PORT = 554;
const STREAM_PATH = "/screenmirror";

console.log(
  `TODO: implement video relay for rtsp://${IP}:${RTSP_PORT}${STREAM_PATH} (see spec §3.5)`,
);
