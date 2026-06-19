// NAL reassembly -> AVCC access units. Spec §3.3.
//
// Delimits access units on the RTP marker bit with a timestamp-change fallback,
// handles single NAL / STAP-A / FU-A payloads, tracks IDR presence to flag
// keyframes, and drops out-of-band parameter sets.

export class H264Depacketizer {
  constructor(
    private readonly onAccessUnit: (
      au: Uint8Array,
      isKeyframe: boolean,
      ts: number,
    ) => void,
  ) {
    // onAccessUnit is retained for the implementation; reference it so the
    // stub passes strict checks/lints.
    void this.onAccessUnit;
  }

  push(_payload: Uint8Array, _marker: boolean, _timestamp: number): void {
    throw new Error("not implemented");
  }
}
