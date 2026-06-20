// @navicoos/rtsp — public barrel. Stable across Phase B (faithful port) and
// Phase C (oversight fixes). See plans/yellowstone-incorporation.md.
//
// The library surface: drive an RTSP/RTP session and receive H.264 access units
// via the onAccessUnit callback. AVCC packaging, SPS/PPS/AUD dropping, and the
// WebCodecs wire framing live in the relay (apps/relay), not here.

export { RtspClient } from "./rtsp_client.ts";
export type { StreamConfig } from "./types.ts";
