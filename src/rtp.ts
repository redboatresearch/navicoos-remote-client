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

export function parseRtp(packet: Uint8Array): RtpPacket {
  const b0 = packet[0];
  const cc = b0 & 0x0f;
  const hasExt = (b0 & 0x10) !== 0;
  const hasPad = (b0 & 0x20) !== 0;
  const marker = (packet[1] & 0x80) !== 0;
  const seq = (packet[2] << 8) | packet[3];
  const timestamp = ((packet[4] << 24) | (packet[5] << 16) | (packet[6] << 8) | packet[7]) >>> 0;

  let offset = 12 + cc * 4;
  if (hasExt) {
    const extWords = (packet[offset + 2] << 8) | packet[offset + 3];
    offset += 4 + extWords * 4;
  }
  let end = packet.length;
  if (hasPad) end -= packet[packet.length - 1];

  return { marker, seq, timestamp, payload: packet.subarray(offset, end) };
}
