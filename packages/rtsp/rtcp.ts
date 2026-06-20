export interface SenderReport {
  ntpTimestampMSW: number;
  ntpTimestampLSW: number;
  rtpTimestamp: number;
  senderPacketCount: number;
  senderOctetCount: number;
}

export interface RTCPPacket {
  buffer: Uint8Array;
  version: number;
  padding: number;
  receptionReportCount: number;
  packetType: number;
  length: number;
  ssrc: number;

  senderReport?: SenderReport;
}

export function parseRTCPPacket(buffer: Uint8Array): RTCPPacket {
  // Packet Types
  // SR         Sender Report                200
  // RR         Receiver Report              201
  // SDES       Source Description           202
  // BYE        Goodbye                      203
  // APP        Application-Defined          204
  // RTPFB      Generic RTP feedback         205
  // PSFB       Payload-specific feedback    206
  // XR         RTCP Extension               207
  const version = buffer[0] >> 6;
  const padding = (buffer[0] >> 5) & 0x01;
  const receptionReportCount = buffer[0] & 0x1f;
  const packetType = buffer[1];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Big-endian reads per RFC 3550. length is in 32-bit words (not bytes);
  // ssrc is an unsigned 32-bit identifier.
  const length = (buffer[2] << 8) | buffer[3];
  const ssrc = view.getUint32(4, false);

  const result: RTCPPacket = {
    buffer,
    version,
    padding,
    length,
    ssrc,
    receptionReportCount,
    packetType,
  };

  if (packetType == 200) {
    const senderReport: SenderReport = {
      ntpTimestampMSW: view.getUint32(8, false),
      ntpTimestampLSW: view.getUint32(12, false),
      rtpTimestamp: view.getUint32(16, false),
      senderPacketCount: view.getUint32(20, false),
      senderOctetCount: view.getUint32(24, false),
    };

    result.senderReport = senderReport;
  }

  return result;
}

export function emptyReceiverReport(clientSSRC: number): Uint8Array {
  const report = new Uint8Array(8);
  const version = 2;
  const paddingBit = 0;
  const reportCount = 0; // an empty report
  const packetType = 201; // Receiver Report
  const length = report.length / 4 - 1; // num 32 bit words minus 1
  report[0] = (version << 6) + (paddingBit << 5) + reportCount;
  report[1] = packetType;
  report[2] = (length >> 8) & 0xff;
  report[3] = (length >> 0) & 0xff;
  report[4] = (clientSSRC >> 24) & 0xff;
  report[5] = (clientSSRC >> 16) & 0xff;
  report[6] = (clientSSRC >> 8) & 0xff;
  report[7] = (clientSSRC >> 0) & 0xff;

  return report;
}
