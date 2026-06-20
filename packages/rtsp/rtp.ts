export interface RTPPacket {
  id: number;
  timestamp: number;
  marker: number;
  padding: number;
  hasExtensions: number;

  payload: Uint8Array;

  length: number;
  paddingLength: number;

  payloadType: number;

  // Additional information added to the Packet
  wallclockTime?: Date;
}

export function parseRTPPacket(buffer: Uint8Array): RTPPacket {
  const padding = (buffer[0] >> 5) & 0x01;
  let paddingLength = 0;
  if (padding == 1) {
    // padding size is the last byte of the RTP data
    paddingLength = buffer[buffer.length - 1];
  }
  const hasExtensions = (buffer[0] >> 4) & 0x01;
  const marker = buffer[1] >>> 7;
  const payloadType = buffer[1] & 0x7f;
  const num_csrc_identifiers = buffer[0] & 0x0f;

  // Payload start: fixed 12-byte header + CSRC list, plus a variable-length
  // extension header when present. The extension header is 2 bytes "defined by
  // profile" + a 2-byte 32-bit-word count, followed by that many words.
  let payloadStart = 12 + num_csrc_identifiers * 4;
  if (hasExtensions) {
    const extWords = (buffer[payloadStart + 2] << 8) | buffer[payloadStart + 3];
    payloadStart += 4 + extWords * 4;
  }
  // Payload end: trim the trailing padding bytes (the last padding byte holds
  // the padding length, which is already captured in paddingLength).
  const payloadEnd = buffer.length - paddingLength;
  const payload = buffer.subarray(payloadStart, payloadEnd);
  const length = payload.length;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  return {
    id: view.getUint16(2, false),
    timestamp: view.getUint32(4, false),
    marker,
    padding,
    payloadType,
    hasExtensions,
    payload,
    length,
    paddingLength,
  };
}

export function randInclusive(min: number, max: number): number {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateSSRC(): number {
  return randInclusive(1, 0xffffffff);
}
