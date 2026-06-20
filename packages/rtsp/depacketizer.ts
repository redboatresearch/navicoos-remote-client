// NAL reassembly from RTP packets. Phase B: faithful port of Yellowstone's
// H264Transport.processRTPFrame() and processRTPPacket().
//
// Quirks are preserved intentionally — corrections come in Phase C.

import type { RTPPacket } from "./rtp.ts";

export interface AccessUnitMeta {
  marker: boolean;
  timestamp: number;
  isKeyframe: boolean;
}

/**
 * Faithful port of Yellowstone's H264Transport.
 *
 * Accumulates RTP payloads per processRTPPacket (push payload; on marker==1,
 * run processRTPFrame over the group and reset). Surfaces reassembled Annex-B
 * NALs via the onAccessUnit callback instead of writing to a file stream.
 */
export class H264Depacketizer {
  // Yellowstone: rtpPackets: Buffer[] = []
  private rtpPackets: Uint8Array[] = [];

  constructor(
    public readonly onAccessUnit: (
      nals: Uint8Array[],
      meta: AccessUnitMeta,
    ) => void,
  ) {}

  /**
   * Faithful port of Yellowstone's processRTPPacket().
   * Accumulates payloads; calls processRTPFrame when marker bit is set.
   */
  processRTPPacket(packet: RTPPacket): void {
    // Accumulate RTP packets
    this.rtpPackets.push(packet.payload);

    // When Marker is set to 1 pass the group of packets to processRTPFrame()
    if (packet.marker == 1) {
      const nals = this.processRTPFrame(this.rtpPackets);
      this.rtpPackets = [];

      // Determine isKeyframe: scan emitted nals for IDR slice (NAL type 5)
      const isKeyframe = nals.some((nal) => nal.length > 0 && (nal[0] & 0x1f) === 5);

      this.onAccessUnit(nals, {
        marker: true,
        timestamp: packet.timestamp,
        isKeyframe,
      });
    }
  }

  /**
   * Faithful port of Yellowstone's processRTPFrame().
   *
   * Quirks preserved verbatim (each annotated):
   *   1. STAP-A loop bound: while (ptr + 2 < packet.length - 1)  — can clip last NAL
   *   2. FU-A: separate if blocks (not else-if), no reset on AU boundary
   *   3. partialNal is number[], converted via Uint8Array.from()
   */
  processRTPFrame(rtpPackets: Uint8Array[]): Uint8Array[] {
    const nals: Uint8Array[] = [];
    // Phase B: faithful to Yellowstone (quirk corrected in Phase C) — partialNal is number[]
    let partialNal: number[] = [];

    for (let i = 0; i < rtpPackets.length; i++) {
      const packet = rtpPackets[i];
      const nal_header_f_bit = (packet[0] >> 7) & 0x01;
      const nal_header_nri = (packet[0] >> 5) & 0x03;
      const nal_header_type = (packet[0] >> 0) & 0x1f;

      if (nal_header_type >= 1 && nal_header_type <= 23) {
        // Normal NAL. Not fragmented
        nals.push(packet);
      } else if (nal_header_type == 24) {
        // Aggregation type STAP-A. Multiple NALs in one RTP Packet
        let ptr = 1; // start after the nal_header_type which was '24'
        // Phase B: faithful to Yellowstone (quirk corrected in Phase C) —
        // bound is ptr + 2 < packet.length - 1, which can clip the last NAL
        while (ptr + 2 < packet.length - 1) {
          const size = (packet[ptr] << 8) + (packet[ptr + 1] << 0);
          ptr = ptr + 2;
          nals.push(packet.subarray(ptr, ptr + size));
          ptr = ptr + size;
        }
      } else if (nal_header_type == 25) {
        // STAP-B
        // Not supported
      } else if (nal_header_type == 26) {
        // MTAP-16
        // Not supported
      } else if (nal_header_type == 27) {
        // MTAP-24
        // Not supported
      } else if (nal_header_type == 28) {
        // Frag FU-A
        // NAL is split over several RTP packets
        // Accumulate them in a temporary buffer
        // Parse Fragmentation Unit Header
        const fu_header_s = (packet[1] >> 7) & 0x01; // start marker
        const fu_header_e = (packet[1] >> 6) & 0x01; // end marker
        // deno-lint-ignore no-unused-vars
        const fu_header_r = (packet[1] >> 5) & 0x01; // reserved. should be 0
        const fu_header_type = (packet[1] >> 0) & 0x1f; // Original NAL unit header

        // Phase B: faithful to Yellowstone (quirk corrected in Phase C) —
        // separate if blocks (not else-if); no reset on AU boundary or timestamp change;
        // no single-fragment (s=1,e=1) handling.

        // Check Start and End flags
        if (fu_header_s == 1 && fu_header_e == 0) {
          // Start of Fragment
          const reconstructed_nal_type = (nal_header_f_bit << 7) + (nal_header_nri << 5) +
            fu_header_type;
          partialNal = [];
          partialNal.push(reconstructed_nal_type);

          // copy the rest of the RTP payload to the temp buffer
          for (let x = 2; x < packet.length; x++) partialNal.push(packet[x]);
        }

        if (fu_header_s == 0 && fu_header_e == 0) {
          // Middle part of fragment
          for (let x = 2; x < packet.length; x++) partialNal.push(packet[x]);
        }

        if (fu_header_s == 0 && fu_header_e == 1) {
          // End of fragment
          for (let x = 2; x < packet.length; x++) partialNal.push(packet[x]);
          // Phase B: faithful to Yellowstone (quirk corrected in Phase C) —
          // Yellowstone: Buffer.from(partialNal) — port to Uint8Array.from()
          nals.push(Uint8Array.from(partialNal));
        }
      } else if (nal_header_type == 29) {
        // Frag FU-B
        // Not supported
      }
    }

    return nals;
  }
}
