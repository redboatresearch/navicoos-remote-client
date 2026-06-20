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

  // Phase B: faithful to Yellowstone's fixed-extension offset assumption (corrected in Phase C)
  // offset = num_csrc_identifiers * 4 + (hasExtensions ? 16 : 12)
  // payload INCLUDES padding (paddingLength is read but not subtracted)
  const payload = buffer.subarray(
    num_csrc_identifiers * 4 + (hasExtensions ? 16 : 12),
  ); // includes padding
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
