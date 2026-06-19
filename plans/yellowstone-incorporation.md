# Incorporating Yellowstone's RTSP/RTP knowledge into our Deno client

**Status:** proposal for review — nothing here is implemented yet. *Hold for
review before building.*
**Author:** Claude (with two exploration sub-agents).
**Reference:** [GyeongHoKim/yellowstone](https://github.com/GyeongHoKim/yellowstone),
cloned to a scratchpad and read in full (`lib/RTSPClient.ts`, `lib/util.ts`,
`lib/transports/RTPPacket.ts`, `lib/transports/H264Transport.ts`).

**Decisions locked in for this revision** (from review):
1. Layout: **`packages/` + `apps/`** workspace.
2. SDP: **incorporate `npm:sdp-transform`** (adopt Yellowstone's choice).
3. Auth: **scaffold it** — and a faithful port gives us Yellowstone's Basic +
   Digest for free, along with its UDP transport.
4. **Adopt Yellowstone's choices in most places.** It is battle-tested; where it
   diverges from the letter of the RFC, assume that divergence has _not mattered
   in real use_ until a probe or a decode failure proves otherwise.

---

## 1. Framing: a faithful port first, fixes second

Yellowstone is a mature, real-world RTSP client. Our earlier audit flagged
several places where it diverges from the RFC — a fixed-size RTP extension
assumption, padding it never trims, a STAP-A loop that can clip the last NAL,
RTCP length/ssrc shift math. **The important context: none of those have caused
problems in Yellowstone's years of production use.** Real cameras rarely set the
extension bit, rarely pad, and the affected paths are edge cases. So we will
**not** pre-emptively "correct" Yellowstone on the way in.

Instead we split the incorporation into **two committed states** so we can build
and trial each against the actual plotter and keep whichever is more robust:

> **Phase B — Faithful Deno port.** Bring Yellowstone's RTSP/RTP/RTCP transport
> and H.264 depacketization across *mechanically*: swap Node APIs for their Deno
> equivalents and **change nothing else**. Quirks preserved on purpose. **Commit.**
>
> **Phase C — Oversight fixes.** Layer our corrections (variable-length
> extension, padding trim, STAP-A tail, FU-A reset, RTCP math, timestamp-change
> AU delimiting, anchored resync) **on top** of the faithful port. **Commit.**

Two commits → two `deno compile` binaries → A/B against the device. If the
faithful port is already rock-solid on this hardware, we may not even need
Phase C; if Phase C is cleaner, we keep it. The git history makes the choice
reversible and the comparison honest.

What is **out of scope** (a scope decision, not a "fix") — the MFD is an H.264
video display, so we omit Yellowstone's AAC/ONVIF-metadata/AV1/H265/H266
transports and the audio backchannel (`RTPPacket.ts`). We port the H.264 path,
the framing core, RTCP, keepalive, auth, and the UDP/TCP transports.

### What "Node→Deno substitution" means (the Phase B rulebook)

Mechanical swaps only — no behavioral edits:

| Node (Yellowstone) | Deno (Phase B) |
|---|---|
| `net.connect` / `net.Socket` | `Deno.connect({ transport: "tcp" })`, read via `conn.readable` reader, write via `conn.write` |
| `tls.connect` | `Deno.connectTls` |
| `dgram` UDP | `Deno.listenDatagram` / `Deno.DatagramConn` |
| `EventEmitter` | tiny `EventTarget`-based emitter shim preserving `.on/.emit/.removeListener` |
| `Buffer` | `Uint8Array` + `DataView` (watch `Buffer.slice`=view vs `Uint8Array.slice`=copy → use `subarray`) |
| `crypto.createHash` (MD5/SHA-256) | `jsr:@std/crypto` (`digest` supports MD5; Web Crypto alone lacks MD5) |
| `sdp-transform` (npm) | **`npm:sdp-transform`** — keep, per decision #2 |
| `url.parse` | WHATWG `new URL()` |
| `stream.Writable` sink | replaced by our AU callback (target adaptation — see API note below) |

The one **non-mechanical** allowance in Phase B is the *output sink*:
Yellowstone's `H264Transport` writes Annex-B NALs to a `.264` file; our consumer
is WebCodecs over a WebSocket. That is a target requirement, not an oversight, so
both phases share a stable library API and only the relay-facing packaging lives
in the app:

```ts
// @navicoos/rtsp public contract — identical across Phase B and Phase C
onAccessUnit(nals: Uint8Array[], meta: { marker: boolean; timestamp: number; isKeyframe: boolean }): void
```

Phase B fills `nals` exactly the way Yellowstone's `processRTPFrame` does
(marker-bit grouping, its STAP-A bound, its FU-A reassembly, no SPS/PPS/AUD
filtering). The **relay** (in `apps/`) does the AVCC length-prefixing, the
SPS/PPS/AUD drop, and the WebCodecs wire framing — unchanged between phases. So
when we A/B, the only variable is the library internals. Phase C swaps those
internals without touching the contract or the relay.

---

## 2. Target monorepo structure

Today: a **single package** (one root `deno.json`, no `workspace` key), and the
probes deliberately *re-implement* RTSP/RTP/SDP because `src/` was stubbed when
they were written. We collapse that into one tested library.

```
navicoos-remote-client/
├── deno.json                 # workspace root: members[], shared fmt/lint, tasks
├── packages/
│   └── rtsp/                 # @navicoos/rtsp — Deno-native RTSP/RTP/H264 core
│       ├── deno.json         #   name + exports; dep: npm:sdp-transform, jsr:@std/crypto
│       ├── mod.ts            #   public barrel (stable across Phase B/C)
│       ├── rtsp_client.ts    #   ← port of Yellowstone RTSPClient (_onData state machine)
│       ├── rtp.ts            #   ← port of util.parseRTPPacket
│       ├── rtcp.ts           #   ← port of util.parseRTCPPacket + empty Receiver Report
│       ├── depacketizer.ts   #   ← port of H264Transport.processRTPFrame (emits nals[])
│       ├── sdp.ts            #   ← Yellowstone SDP handling via npm:sdp-transform
│       ├── transport.ts      #   injectable socket iface (TCP/TLS/UDP behind Deno APIs)
│       ├── auth.ts           #   ← port of Basic/Digest (_generateAuthString)
│       ├── emitter.ts        #   EventTarget-based EventEmitter shim
│       ├── types.ts
│       └── *_test.ts         #   characterization tests (Phase B) → correctness tests (Phase C)
├── apps/
│   └── relay/                # @navicoos/relay — the application shell
│       ├── deno.json
│       ├── main.ts           #   Deno.serve WS relay; AVCC packaging; per-conn state; serves frontend
│       └── frontend/         #   ← frontend/ (index.html, decoder.js)
├── scripts/                  # probes — now import @navicoos/rtsp (delete _rtsp.ts)
├── plans/                    # this document
└── reference-client/         # untouched Python
```

Effect on config / packages:
- Root `deno.json`: add `"workspace": ["packages/rtsp", "apps/relay"]`; widen
  fmt/lint `include` to `packages/`, `apps/`, `scripts/`; tasks `start`/`compile`
  → `apps/relay/main.ts`, `check`/`test` → workspace-wide, `probe:*` unchanged.
- `packages/rtsp/deno.json`: `"name": "@navicoos/rtsp"`, an `"exports"` map, and
  the **new dependencies** `npm:sdp-transform` and `jsr:@std/crypto`.
- `apps/relay` is the only member importing `Deno.serve` / `Deno.upgradeWebSocket`
  → `deno compile` stays pointed there.
- Probes drop their private protocol copies and import `@navicoos/rtsp`;
  `scripts/_rtsp.ts` is deleted.

---

## 3. Phased agent execution

Each wave is one focused **sonnet** sub-agent with a tight brief, gated on
`deno task check` + `lint` + (from Phase B on) `test` staying green. I
orchestrate, review every diff, and own commits/pushes to
`claude/charming-planck-ggb378` (PR #1).

### Phase A — Workspace scaffold (structural; no protocol logic)
Stand up `packages/rtsp` + `apps/relay`, the root workspace `deno.json`, the
`npm:sdp-transform` / `jsr:@std/crypto` deps, and move `frontend/` under the
relay. `git mv` where possible; prove `deno task check` passes. Small — likely
done directly rather than via agent. **No commit boundary of its own; folds into
Phase B's first commit** (or a trivial "scaffold workspace" commit if large).

### Phase B — Faithful Deno port  → **commit**
Mechanical Node→Deno port per the §1 rulebook, quirks preserved.

- **B1 — `emitter.ts` + `transport.ts`.** EventEmitter shim; injectable
  TCP/TLS/UDP socket interface backed by `Deno.connect`/`connectTls`/
  `listenDatagram`.
- **B2 — `rtp.ts` + `rtcp.ts`.** Port `parseRTPPacket` and `parseRTCPPacket`
  *verbatim in behavior* (yes, including the fixed-extension assumption, the
  un-trimmed padding, and the RTCP shift math). `Buffer`→`DataView`.
- **B3 — `rtsp_client.ts`.** Port the `_onData` `ReadStates` state machine, the
  request/response engine, SETUP/PLAY/PAUSE/TEARDOWN, the **20 s OPTIONS
  keepalive**, **Session** handling, the **RTCP Receiver-Report reply**, and both
  the **TCP-interleaved and UDP** transports. `String.fromCharCode.apply` ported
  as-is for now (TextDecoder is a Phase-C fix).
- **B4 — `auth.ts`.** Port Basic + Digest (MD5/SHA-256) challenge/response via
  `jsr:@std/crypto`.
- **B5 — `sdp.ts` + `depacketizer.ts`.** SDP via `npm:sdp-transform` (mirroring
  Yellowstone's `parse`/`parseParams` usage); depacketizer reproduces
  `processRTPFrame` exactly but emits `nals[]` through the stable callback
  instead of writing Annex-B to a file.
- **B6 — relay wiring (`apps/relay/main.ts`).** Enough to *run and trial*:
  consume `onAccessUnit`, do AVCC packaging + SPS/PPS/AUD drop + WebCodecs
  framing, **per-connection state** (no module globals), **serve the frontend**,
  `try/catch` the async chain. (These last two are our-code correctness, not
  Yellowstone oversights, so they belong in both phases — hence here.)
- **B7 — characterization tests.** `deno test` over captured byte fixtures
  asserting the port reproduces Yellowstone's behavior (these document the
  quirks; Phase C will flip the assertions to "correct").

Result: a working, Yellowstone-faithful `@navicoos/rtsp` driving the relay.
**Commit** (tag, e.g. `port/faithful`).

### Phase C — Oversight fixes  → **commit**
Layer corrections onto the ported library; relay + public API untouched.

- RTP: variable-length **extension** skip; **padding** trim.
- RTCP: fix `length` / `ssrc` shift math.
- Depacketizer: correct **STAP-A** tail bound + bounds check; **FU-A** reset on
  AU boundary / timestamp change + single-fragment (`s&&e`) handling;
  **timestamp-change AU delimiting** alongside the marker bit.
- Framing: **anchored resync** instead of throwing on an unexpected byte;
  `TextDecoder` for large SDP bodies.
- Flip B7's characterization tests to correctness tests; add regression tests
  (extension+padding packet, STAP-A tail NAL, lost FU-A end fragment).

**Commit** (tag, e.g. `port/fixed`).

### Phase D — Probe-gated verification & tuning (BLOCKED on device output)
After you run `deno task probe:transport` / `probe:stream` against
`192.168.0.1:554/screenmirror`:
- **Transport** (TCP-interleaved vs UDP-only) — both paths already exist from the
  faithful port; the probe just tells us which to default to.
- **Auth** — if a request 401s, auth is already ported; the probe tells us
  whether it's exercised.
- **In-band SPS/PPS** — if SDP lacks `sprop-parameter-sets` (Yellowstone relies
  on it too), implement first-keyframe capture. Net-new in both codebases.
- **Marker vs timestamp delimiting** — the stream probe confirms whether Phase
  C's timestamp fallback is load-bearing on this device.

---

## 4. Trialing the two builds

The whole point of the two-commit split:

```sh
git checkout port/faithful && deno task compile -o relay-faithful
git checkout port/fixed    && deno task compile -o relay-fixed
# run each against the plotter, compare decode stability / desync / dropped frames
```

Keep whichever is more robust on real hardware; if it's a wash, keep `port/fixed`
(strictly more RFC-correct at no observed cost). Either way the loser stays in
history, so reverting is a `git checkout`.

---

## 5. Sequencing & remaining questions

Phases A–C are **device-independent** — pure structure + port + fixes, validated
by `deno check`/`lint`/`test`. They can all land before probe output arrives.
Phase D is the only device-gated piece, and only for *defaults and the one
net-new in-band-SPS/PPS path* — transport, auth, and keepalive all come across in
the faithful port.

Per decision #4, I'm **holding for your review** before starting Phase A. Two
small things worth confirming when you're ready:
- **Tag names** for the two trial commits (`port/faithful` / `port/fixed` ok?).
- Whether you want Phase A as its **own scaffold commit** (cleaner history) or
  folded into the Phase B commit (fewer commits on the PR).
