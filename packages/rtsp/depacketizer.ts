// NAL reassembly from RTP packets. Faithful port of Yellowstone's
// H264Transport.processRTPFrame() and processRTPPacket(), with three targeted
// RFC 6184 correctness fixes applied (STAP-A tail bound, FU-A reassembly,
// timestamp-change AU delimiting).

import type { RTPPacket } from "./rtp.ts";

export interface AccessUnitMeta {
  marker: boolean;
  timestamp: number;
  isKeyframe: boolean;
}

/**
 * Faithful port of Yellowstone's H264Transport.
 *
 * Accumulates RTP payloads per processRTPPacket (push payload; on marker==1 OR
 * a timestamp change, run processRTPFrame over the group and reset). Surfaces
 * reassembled Annex-B NALs via the onAccessUnit callback instead of writing to
 * a file stream.
 */
export class H264Depacketizer {
  // Yellowstone: rtpPackets: Buffer[] = []
  private rtpPackets: Uint8Array[] = [];
  // Timestamp of the buffered group, used to delimit access units when the
  // timestamp advances without a preceding marker bit.
  private lastTimestamp: number | null = null;

  constructor(
    public readonly onAccessUnit: (
      nals: Uint8Array[],
      meta: AccessUnitMeta,
    ) => void,
  ) {}

  /**
   * Faithful port of Yellowstone's processRTPPacket().
   *
   * Accumulates payloads; flushes the buffered group when the timestamp
   * changes (before pushing the new payload) or when the marker bit is set.
   */
  processRTPPacket(packet: RTPPacket): void {
    // A new timestamp closes the previous access unit (marker-bit fallback).
    // Flush the buffered group using the previous timestamp before adding this
    // packet to a fresh group.
    if (
      this.lastTimestamp !== null &&
      packet.timestamp !== this.lastTimestamp &&
      this.rtpPackets.length > 0
    ) {
      this.flushGroup(this.lastTimestamp);
    }
    this.lastTimestamp = packet.timestamp;

    // Accumulate RTP packets
    this.rtpPackets.push(packet.payload);

    // When Marker is set to 1 pass the group of packets to processRTPFrame()
    if (packet.marker == 1) {
      this.flushGroup(packet.timestamp);
    }
  }

  /**
   * Reassemble the buffered RTP group into an access unit, emit it via
   * onAccessUnit, and reset the buffer.
   */
  private flushGroup(timestamp: number): void {
    const nals = this.processRTPFrame(this.rtpPackets);
    this.rtpPackets = [];

    // Determine isKeyframe: scan emitted nals for IDR slice (NAL type 5)
    const isKeyframe = nals.some((nal) => nal.length > 0 && (nal[0] & 0x1f) === 5);

    this.onAccessUnit(nals, {
      marker: true,
      timestamp,
      isKeyframe,
    });
  }

  /**
   * Faithful port of Yellowstone's processRTPFrame().
   *
   * Handles single NALs, STAP-A aggregation, and FU-A fragmentation. The FU-A
   * partial buffer is function-scoped so a mid-frame partial never leaks across
   * access units.
   */
  processRTPFrame(rtpPackets: Uint8Array[]): Uint8Array[] {
    const nals: Uint8Array[] = [];
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
        // Iterate while a full 2-byte size prefix remains so the final
        // aggregated NAL is not clipped.
        while (ptr + 2 <= packet.length) {
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

        if (fu_header_s == 1) {
          // Start of fragment: reset the partial and seed it with the
          // reconstructed NAL header, then append this packet's payload.
          const reconstructed_nal_header = (nal_header_f_bit << 7) +
            (nal_header_nri << 5) + fu_header_type;
          partialNal = [reconstructed_nal_header];
          for (let x = 2; x < packet.length; x++) partialNal.push(packet[x]);
        } else if (partialNal.length > 0) {
          // Middle or end continuation: append this packet's payload.
          for (let x = 2; x < packet.length; x++) partialNal.push(packet[x]);
        }

        if (fu_header_e == 1 && partialNal.length > 0) {
          // End of fragment: emit the reassembled NAL and clear the partial.
          // A single-fragment NAL (s=1,e=1) works naturally: reset, append,
          // then flush within this one packet.
          nals.push(Uint8Array.from(partialNal));
          partialNal = [];
        }
      } else if (nal_header_type == 29) {
        // Frag FU-B
        // Not supported
      }
    }

    return nals;
  }
}
