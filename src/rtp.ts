// RTP header parsing (variable length). Spec §3.1.
//
// The RTP header is NOT a fixed 12 bytes: CSRC count adds 4 bytes each, the
// extension bit adds a variable header, and the padding bit means trailing
// bytes must be trimmed.

export interface RtpPacket {
  marker: boolean;
  seq: number;
  timestamp: number; // 32-bit, unsigned
  payload: Uint8Array; // H.264 RTP payload (NAL-layer)
}

export function parseRtp(_packet: Uint8Array): RtpPacket {
  throw new Error("not implemented");
}
