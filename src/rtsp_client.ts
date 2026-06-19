// RTSP handshake + interleaved read loop. Spec §3.4.
//
// A real request -> read response -> next request state machine:
// OPTIONS -> DESCRIBE -> SETUP -> PLAY, then drives the $-framed interleaved
// binary stream until the connection closes.

import type { StreamConfig } from "./types.ts";

export class RtspClient {
  constructor(
    private readonly ip: string,
    private readonly port: number,
    private readonly path: string,
  ) {
    // Retained for the implementation; reference so the stub stays strict-clean.
    void this.ip;
    void this.port;
    void this.path;
  }

  connect(): Promise<void> {
    throw new Error("not implemented");
  }

  handshake(): Promise<StreamConfig> {
    throw new Error("not implemented");
  }

  // Drives the interleaved binary stream until the connection closes.
  runVideoLoop(
    _onAccessUnit: (au: Uint8Array, isKeyframe: boolean, rtpTs: number) => void,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    throw new Error("not implemented");
  }
}
