# Phase C handoff — RFC-correctness fixes over the faithful port

**Read this first, then `plans/yellowstone-incorporation.md` §1 + §Phase C + §4.**

## Where we are

- **Phase B is committed**: `8c6134c` "Port Yellowstone RTSP client to Deno
  workspace (faithful)", tagged **`port/faithful`**. Branch
  `claude/charming-planck-ggb378`. Nothing pushed.
- Workspace is green: `deno task check` / `lint` / `fmt` all pass (14/16 files).
- The `@navicoos/rtsp` package is a **deliberately quirk-preserving** mechanical
  port of Yellowstone. The relay (`apps/relay/main.ts`) does AVCC packaging,
  SPS/PPS/AUD drop, WebCodecs framing, per-connection state.
- **Tests are deferred to Phase D** (decision: no real wire captures or
  Yellowstone fixtures exist — fabricating expected bytes was rejected). Do NOT
  write characterization tests in Phase C against made-up data. Phase C may add
  regression tests *only* once real captures exist, or pure-logic tests whose
  expected values are independently derivable (not read back off the code).

## What Phase C does

Layer corrections **onto** the faithful port. **The public contract and the
relay do not change** — only the library internals. Then commit + tag
**`port/fixed`**, so the two tags can be A/B compiled and trialed (plan §4):

```sh
git checkout port/faithful && deno task compile -o relay-faithful
git checkout port/fixed    && deno task compile -o relay-fixed
# run each against 192.168.0.1:554/screenmirror; keep the more robust build
```

## ⚠️ Critical constraint — do not revert the API

The old `src/` files (see below) are the **algorithm reference for what
"correct" looks like**, NOT a drop-in. They use a *different, older API*:
`parseRtp(): RtpPacket {marker,seq,timestamp,payload}`, a depacketizer
`push(payload,marker,ts)` that builds the **AVCC AU itself** and **drops
SPS/PPS/AUD internally**.

Phase C must apply the corrected **logic** inside the **faithful port's
contract**, which is different and must be preserved:
- `parseRTPPacket(buffer: Uint8Array): RTPPacket` keeps ALL its fields
  (`id`, `marker`, `padding`, `hasExtensions`, `payloadType`, `length`,
  `paddingLength`, `payload`, `timestamp`).
- `H264Depacketizer` keeps `onAccessUnit(nals: Uint8Array[], meta: { marker,
  timestamp, isKeyframe })` — it emits **raw NALs**, NOT an AVCC AU.
- **AVCC length-prefixing AND the SPS/PPS/AUD (type 7/8/9) drop stay in the
  relay** (`apps/relay/main.ts` `buildAvccAu`). Do NOT move param-set dropping
  back into the depacketizer (the old code did it there — don't).

## The fix list (plan §Phase C), each mapped to its site

Every fix site in the faithful port is marked with a `// Phase C` /
`// Phase B: faithful … (corrected in Phase C)` comment. Find them all:

```sh
grep -rn "Phase C\|Phase B: faithful" packages/rtsp/
```

1. **`packages/rtsp/rtp.ts:31`** — RTP **variable-length extension** skip +
   **padding trim**. Currently `subarray(csrc*4 + (hasExtensions?16:12))` with no
   end bound. Correct: compute extension length from its 2-byte word count and
   trim trailing padding bytes. (Reference: old `src/rtp.ts` `parseRtp`, embedded
   below — note `offset += 4 + extWords*4` and `end -= packet[last]`.)
2. **`packages/rtsp/rtcp.ts:35`** — fix `length` / `ssrc` shift math. Current
   (buggy, faithful): `length = buffer[2] << (8 + buffer[3])`,
   `ssrc = ((buffer[4] << (24+buffer[5])) << (16+buffer[6])) << (8+buffer[7])`.
   Correct: `length = (buffer[2] << 8) | buffer[3]`, and read `ssrc` as a
   big-endian uint32 via `DataView.getUint32(4, false)`.
3. **`packages/rtsp/depacketizer.ts`** (markers at lines ~66/81/109/133):
   - **STAP-A tail bound** — change `while (ptr + 2 < packet.length - 1)` to a
     correct bound so the last aggregated NAL is not clipped (old code:
     `while (off + 2 <= payload.length)`).
   - **FU-A reset on AU boundary / timestamp change** + **single-fragment
     (s&&e) handling** — the faithful version has three separate `if`s and never
     resets `partialNal`; old code resets `fu` on `start`, appends on middle,
     flushes on `end`, and `start&&end` works because reset-then-flush.
   - **timestamp-change AU delimiting** alongside the marker bit — old code:
     `if (this.ts !== null && timestamp !== this.ts && this.nals.length) flush()`.
   - Keep `isKeyframe` = "an IDR (type 5) is present in the AU".
4. **`packages/rtsp/rtsp_client.ts`** (markers at ~796/898/961/977):
   - **`TextDecoder`** for header/payload text instead of
     `String.fromCharCode.apply` (lines ~898, ~961).
   - **Anchored resync** instead of throwing on an unexpected byte in the
     `_onData` state machine (lines ~796–797, ~977–978): on a bad byte, scan
     forward to the next plausible frame anchor (`$` interleaved marker or
     `RTSP/`) rather than `throw`.
5. **Tests** — per the deferral, do NOT flip fabricated characterization tests.
   Add regression tests only with real/independently-derivable data (Phase D).

## High-fidelity sources

| Source | What it gives you | Where (durable) |
|---|---|---|
| This plan | full Phase C spec + rationale | `plans/yellowstone-incorporation.md` |
| **Corrected reference code** (the old client we replaced) | what "correct" looks like — algorithm, not API | `git show port/faithful~1:src/rtp.ts` (also `:src/depacketizer.ts`, `:src/sdp.ts`, `:src/rtsp_client.ts`, `:src/main.ts`). Parent commit = `dc401da`. |
| **Quirky reference** (Yellowstone, what we port *away* from) | the bugs, verbatim | The faithful files themselves carry the quirks + comments. Original: clone `GyeongHoKim/yellowstone`, read `lib/util.ts`, `lib/RTSPClient.ts`, `lib/transports/H264Transport.ts`. (Scratchpad clone is ephemeral — re-clone if gone.) |
| Memory | port strategy + working style | `…/memory/yellowstone-port-plan.md`, `…/memory/use-agents-for-work.md` |

### Embedded corrected reference — `src/rtp.ts` (old, pre-Phase-B)

```ts
// RTP header parsing (variable length). Spec §3.1.
export interface RtpPacket {
  marker: boolean;
  seq: number;
  timestamp: number; // 32-bit, unsigned
  payload: Uint8Array;
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
    offset += 4 + extWords * 4;   // <-- variable-length extension skip
  }
  let end = packet.length;
  if (hasPad) end -= packet[packet.length - 1];   // <-- padding trim

  return { marker, seq, timestamp, payload: packet.subarray(offset, end) };
}
```

> Apply this logic inside faithful `parseRTPPacket` — keep returning the full
> `RTPPacket` (id/payloadType/padding/hasExtensions/length/paddingLength etc.),
> just fix the extension offset and trim the payload by `paddingLength`.

### Embedded corrected reference — `src/depacketizer.ts` (old, pre-Phase-B)

```ts
// NAL reassembly. Delimits AUs on marker bit + timestamp-change fallback,
// handles single NAL / STAP-A / FU-A, flags IDR keyframes, drops param sets.
// NOTE: this old version builds AVCC + drops SPS/PPS/AUD ITSELF. In Phase C the
// depacketizer must instead emit raw nals[] via onAccessUnit(nals, meta); AVCC
// and the param-set drop stay in the relay. Port only the reassembly LOGIC.

export class H264Depacketizer {
  private nals: Uint8Array[] = [];
  private fu: Uint8Array[] | null = null;
  private hasIdr = false;
  private ts: number | null = null;

  push(payload: Uint8Array, marker: boolean, timestamp: number): void {
    if (payload.length === 0) return;
    // New timestamp closes the previous access unit (marker-bit fallback):
    if (this.ts !== null && timestamp !== this.ts && this.nals.length) this.flush();
    this.ts = timestamp;

    const type = payload[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.add(payload);
    } else if (type === 24) { // STAP-A
      let off = 1;
      while (off + 2 <= payload.length) {          // <-- correct tail bound
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
      const reconstructed = (payload[0] & 0xe0) | origType;
      if (start) this.fu = [Uint8Array.of(reconstructed), payload.subarray(2)]; // <-- reset on start
      else if (this.fu) this.fu.push(payload.subarray(2));
      if (end && this.fu) { this.add(concat(this.fu)); this.fu = null; }        // <-- start&&end works
    }
    if (marker) this.flush();
  }
  // add(): drops type 7/8/9 + tracks IDR — in Phase C, do the drop in the RELAY,
  //        keep IDR tracking here for isKeyframe.
  // flush(): old code length-prefixes into AVCC — in Phase C, emit raw nals[].
}
```

> The corrected `src/rtsp_client.ts` (TextDecoder usage + resync) and
> `src/sdp.ts` are larger — read them with
> `git show port/faithful~1:src/rtsp_client.ts` and `…:src/sdp.ts`.

## Process notes carried forward

- **Use sub-agents to conserve main-thread context** (`use-agents-for-work`
  memory). One focused agent per fix-cluster (e.g. rtp+rtcp; depacketizer;
  rtsp_client text/resync), file sets disjoint where possible. Review every diff.
- **Subagent recursion finding**: in Phase B, `general-purpose` agents
  reflexively spawned grandchild agents to read files (NOT caused by memory —
  confirmed not injected; NOT caused by brief wording — the agent intended to
  read directly and delegated anyway). Root enabling condition: the agent type
  carries the `Agent` tool. No fix was applied (it didn't harm output). If it
  becomes costly, create a `.claude/agents/` implementer type without `Agent`.
- After each fix-cluster: `deno task check && deno task lint && deno task fmt`.
- Final: commit, `git tag port/fixed`. Then Phase D (device-gated) per plan §5.
```
