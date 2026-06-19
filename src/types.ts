// Shared wire contracts for the RTSP video client.
// See spec §2 for the authoritative definitions.

/**
 * SDP-derived stream configuration, produced once at handshake time.
 * Spec §2.1.
 */
export interface StreamConfig {
  controlUrl: string; // resolved from SDP a=control:
  codecString: string; // e.g. "avc1.42001e", from profile-level-id
  sps: Uint8Array; // raw NAL (starts 0x67), no start code / length prefix
  pps: Uint8Array; // raw NAL (starts 0x68)
  payloadType: number; // e.g. 96
  clockRate: number; // 90000 for H.264
}

/**
 * WebSocket binary frame layout (Deno -> frontend). Spec §2.2.
 *
 *   | Bytes | Field      | Notes                                                      |
 *   |-------|------------|------------------------------------------------------------|
 *   | 0     | flags      | bit0 = keyframe (1 = AU contains an IDR slice)             |
 *   | 1-8   | timestamp  | 64-bit big-endian microseconds, monotonic, rel. to frame 0 |
 *   | 9...  | access unit | AVCC: each NAL prefixed with a 4-byte big-endian length    |
 *
 * Access units are AVCC (length-prefixed), NOT Annex-B start codes (spec §2.3).
 * SPS/PPS/AUD (NAL types 7/8/9) are dropped from the forwarded AU because the
 * parameter sets are delivered out-of-band in the decoder config.
 *
 * A separate JSON text message of the following shape is sent before any binary
 * frame so the frontend can configure its VideoDecoder:
 *
 *   { type: "config", codec: string, sps: number[], pps: number[] }
 */
