// NAL reassembly -> AVCC access units. Spec §3.3.
//
// Delimits access units on the RTP marker bit with a timestamp-change fallback,
// handles single NAL / STAP-A / FU-A payloads, tracks IDR presence to flag
// keyframes, and drops out-of-band parameter sets.

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export class H264Depacketizer {
  private nals: Uint8Array[] = [];
  private fu: Uint8Array[] | null = null;
  private hasIdr = false;
  private ts: number | null = null;

  constructor(
    private readonly onAccessUnit: (au: Uint8Array, isKeyframe: boolean, ts: number) => void,
  ) {}

  push(payload: Uint8Array, marker: boolean, timestamp: number): void {
    if (payload.length === 0) return;

    // New timestamp closes the previous access unit (marker-bit fallback).
    if (this.ts !== null && timestamp !== this.ts && this.nals.length) this.flush();
    this.ts = timestamp;

    const type = payload[0] & 0x1f;

    if (type >= 1 && type <= 23) {
      this.add(payload);
    } else if (type === 24) { // STAP-A
      let off = 1;
      while (off + 2 <= payload.length) {
        const size = (payload[off] << 8) | payload[off + 1];
        off += 2;
        this.add(payload.subarray(off, off + size));
        off += size;
      }
    } else if (type === 28) { // FU-A
      const fuHeader = payload[1];
      const start = (fuHeader & 0x80) !== 0;
      const end = (fuHeader & 0x40) !== 0;
      const origType = fuHeader & 0x1f;
      const reconstructed = (payload[0] & 0xe0) | origType; // F+NRI from indicator
      if (start) this.fu = [Uint8Array.of(reconstructed), payload.subarray(2)];
      else if (this.fu) this.fu.push(payload.subarray(2));
      if (end && this.fu) {
        this.add(concat(this.fu));
        this.fu = null;
      }
    }
    // Types 25-27/29 (STAP-B, MTAP, FU-B) are not used by single-stream H.264; ignore.

    if (marker) this.flush();
  }

  private add(nal: Uint8Array): void {
    if (nal.length === 0) return;
    const t = nal[0] & 0x1f;
    if (t === 5) this.hasIdr = true;
    if (t === 7 || t === 8 || t === 9) return; // SPS/PPS/AUD delivered out-of-band
    this.nals.push(nal);
  }

  private flush(): void {
    if (!this.nals.length) {
      this.hasIdr = false;
      return;
    }
    const total = this.nals.reduce((a, n) => a + 4 + n.length, 0);
    const au = new Uint8Array(total);
    let o = 0;
    for (const n of this.nals) {
      au[o] = (n.length >>> 24) & 0xff;
      au[o + 1] = (n.length >>> 16) & 0xff;
      au[o + 2] = (n.length >>> 8) & 0xff;
      au[o + 3] = n.length & 0xff;
      au.set(n, o + 4);
      o += 4 + n.length;
    }
    const isKey = this.hasIdr;
    const ts = this.ts ?? 0;
    this.nals = [];
    this.hasIdr = false;
    this.onAccessUnit(au, isKey, ts);
  }
}
