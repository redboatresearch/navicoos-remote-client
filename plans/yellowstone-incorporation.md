# Incorporating Yellowstone's RTSP/RTP knowledge into our Deno client

**Status:** proposal for review — nothing here is implemented yet.
**Author:** Claude (with two exploration sub-agents).
**Reference:** [GyeongHoKim/yellowstone](https://github.com/GyeongHoKim/yellowstone),
cloned to a scratchpad and read in full (`lib/RTSPClient.ts`, `lib/util.ts`,
`lib/transports/RTPPacket.ts`, `lib/transports/H264Transport.ts`).

---

## 1. TL;DR — what we learned

Yellowstone is a battle-tested Node RTSP client. But after auditing both
codebases side by side, the headline is counterintuitive:

> **Our hand-written parsing is _more_ correct than Yellowstone's in several
> spots. Yellowstone's value to us is its _architecture_, not its bit-twiddling.**

Where **we are already better** (keep ours, do not regress):

| Concern | Yellowstone | Us |
|---|---|---|
| RTP extension header | assumes fixed 4 bytes (`hasExt ? 16 : 12`) — **bug** for any packet with X set (`util.ts:34`) | reads the real `extWords` length and skips `4 + extWords*4` (`rtp.ts:24-27`) ✅ |
| RTP padding | computed but **never trimmed** from payload (`util.ts:33-36`) | trims `end -= lastByte` (`rtp.ts:29`) ✅ |
| STAP-A tail | loop bound `ptr+2 < len-1` can **drop the last NAL** (`H264Transport.ts:96`) | `off+2 <= len` reads every NAL (`depacketizer.ts:41`) ✅ |
| Output format | Annex-B start codes (for `.264` files) | AVCC length-prefix (for WebCodecs) ✅ correct for our target |
| Param sets | forwards SPS/PPS/AUD inline | drops 7/8/9, delivers out-of-band in avcC ✅ correct for WebCodecs |

Where **Yellowstone is better** (adopt its approach):

| Concern | Yellowstone | Us (today) |
|---|---|---|
| **Interleaved framing** | a true byte-by-byte **state machine** (`_onData`, `ReadStates`) that cleanly demuxes `$`-binary vs `RTSP/` text on one socket | a heuristic (`runVideoLoop`) that sniffs `buf[0]` each iteration and re-aligns on a **single CRLF** — **permanently desyncs** if a `0x0d0a` appears inside an H.264 payload |
| **RTCP** | parses RTCP, sends empty **Receiver Reports** back (keeps servers happy / NAT open) | ignores channel 1 entirely |
| **Keepalive** | `OPTIONS` every 20 s with the `Session` id | none — long sessions may time out |
| **Session/TEARDOWN** | captures `Session`, strips params, reuses on PLAY/PAUSE/TEARDOWN/keepalive | captures Session, but no keepalive and minimal lifecycle |
| **Auth** | Basic + Digest (MD5/SHA-256) challenge/response | none |
| **UDP fallback** | full `dgram` RTP/RTCP path | TCP-interleaved only |

Plus bugs **we already know about** in our own code, independent of Yellowstone:
1. FU-A `this.fu` is **not reset** on a timestamp-change flush — a lost end
   fragment splices NALs across access-unit boundaries (`depacketizer.ts:32`).
2. `main.ts` `firstTs` / `started` are **module globals** — a second WebSocket
   connection never re-arms the keyframe gate or the timestamp anchor.
3. `main.ts` non-WS branch returns the literal string `"video relay"` and
   **never serves `frontend/index.html`**.
4. Heavy **duplication**: the `$`-frame loop exists in 3 places, `parseRtp` and
   the SDP scanner in 2 each (`src/` vs `scripts/`).

**Conclusion:** the work is (a) restructure into a real Deno workspace so there
is _one_ trusted library, (b) graft Yellowstone's framing/RTCP/keepalive/auth
architecture onto our correct parsing core, (c) fix our four known bugs, (d)
delete the duplication. All of this is device-independent and can proceed before
the probe results come back; only auth and the UDP fallback are gated on probes.

---

## 2. Target monorepo structure

Today the repo is a **single package** — one root `deno.json`, everything under
`src/` + `scripts/`, no `workspace` key. The biggest structural problem is that
the probes deliberately **re-implement** the RTSP/RTP/SDP logic instead of
importing it (because `src/` was stubbed when they were written). That rationale
is gone; we want one library both the relay and the probes consume.

Proposed Deno **workspace** layout (`"workspace"` member list in the root
`deno.json`):

```
navicoos-remote-client/
├── deno.json                 # workspace root: members[], shared fmt/lint, top-level tasks
├── packages/
│   └── rtsp/                 # @navicoos/rtsp — the reusable, Deno-native core (NEW home)
│       ├── deno.json         #   name + exports map
│       ├── mod.ts            #   public barrel
│       ├── rtp.ts            #   ← src/rtp.ts (already correct; keep)
│       ├── rtcp.ts           #   NEW: parse RTCP + build empty Receiver Report
│       ├── sdp.ts            #   ← src/sdp.ts (hardened; in-band SPS/PPS fallback)
│       ├── depacketizer.ts   #   ← src/depacketizer.ts (FU-A reset fix)
│       ├── framing.ts        #   NEW: Yellowstone-style $-frame/RTSP-text state machine
│       ├── transport.ts      #   NEW: injectable socket iface (Deno.connect behind it)
│       ├── rtsp_client.ts    #   ← src/rtsp_client.ts (uses framing.ts + transport.ts)
│       ├── auth.ts           #   NEW (probe-gated): Basic/Digest
│       ├── types.ts          #   ← src/types.ts
│       └── *_test.ts         #   NEW: unit tests over captured byte fixtures
├── apps/
│   └── relay/                # @navicoos/relay — the application shell
│       ├── deno.json
│       ├── main.ts           #   ← src/main.ts (per-conn state; serves frontend)
│       └── frontend/         #   ← frontend/ (index.html, decoder.js)
├── scripts/                  # probes — now IMPORT @navicoos/rtsp instead of _rtsp.ts
│   ├── probe_transport.ts
│   └── probe_stream.ts
├── plans/                    # this document
└── reference-client/         # untouched Python (already excluded from fmt/lint)
```

Why a workspace and not just folders:
- **One source of truth.** `framing.ts`, `parseRtp`, the SDP scanner, and the
  NAL classifier collapse from 2–3 copies to one. `scripts/_rtsp.ts` is deleted.
- **Testability.** `packages/rtsp` becomes pure/portable enough to unit-test
  with `deno test` over recorded byte fixtures (no live device needed) — the
  state machine and depacketizer are exactly the kind of code that needs tests.
- **Clean compile target.** `apps/relay` is the only thing that imports
  `Deno.serve`/`Deno.upgradeWebSocket`; `deno compile` stays pointed at it.
- **Dependency hygiene.** The library can stay **zero-dependency** (we keep our
  hand-rolled SDP rather than pulling Yellowstone's `npm:sdp-transform`), which
  keeps the compiled binary self-contained.

### Effect on `deno.json` / packages
- Root `deno.json` gains `"workspace": ["packages/rtsp", "apps/relay"]`; fmt/lint
  `include` globs widen to `packages/`, `apps/`, `scripts/`. Tasks become:
  `start` → `apps/relay/main.ts`; `compile` → `apps/relay/main.ts`;
  `check`/`test` → workspace-wide; `probe:*` unchanged paths.
- `packages/rtsp/deno.json` declares `"name": "@navicoos/rtsp"` and an
  `"exports"` map so `apps/relay` and `scripts/` import `@navicoos/rtsp` by name.
- **No new third-party packages** in the default plan. Two _optional, deferred_
  std deps, only if probes prove them necessary: `jsr:@std/crypto` (MD5 for
  Digest auth — Web Crypto has no MD5) and `jsr:@std/encoding/base64` (if we
  stop relying on `atob`). Both are std, both stay out unless required.

---

## 3. How the sonnet agents do the work

Each wave is one focused **sonnet** sub-agent with a tight brief, fixture-backed
where possible, and a hard gate: it must leave `deno task check`, `deno task
lint`, and (from Wave 1 on) `deno task test` green before I review and commit.
I orchestrate, review every diff, and own the commits/pushes to
`claude/charming-planck-ggb378` (updating PR #1).

**Wave 0 — Workspace scaffold (no logic changes).**
Move files with `git mv` into `packages/rtsp` + `apps/relay`, add the workspace
`deno.json`s, fix import specifiers, prove `deno task check` still passes. Small
enough that I may do it directly rather than spawn an agent.

**Wave 1 — Library core + tests (device-independent).**
Agent: relocate `rtp.ts`/`depacketizer.ts`/`sdp.ts`/`types.ts` into the package
and write `deno test` suites over **captured byte fixtures** (hand-built RTP
packets: single NAL, STAP-A with a tail NAL, multi-packet FU-A, a packet with an
extension header + padding to lock in our correctness advantage over
Yellowstone). Fix the **FU-A dangling bug** here (reset `this.fu` on
timestamp-change flush and AU boundary) with a regression test for the
lost-end-fragment case.

**Wave 2 — Framing state machine + transport abstraction (the big one).**
Agent: port Yellowstone's `_onData` `ReadStates` machine to Deno as
`framing.ts` — a push-driven parser (`feed(chunk) -> events`) that demuxes
`$`-binary frames from `RTSP/` text using **two legal lead bytes only** (`0x24`
/ `0x52`) and `\r\n\r\n` (not a single CRLF) as the text terminator, with an
anchored resync instead of a throw. Introduce `transport.ts` (an injectable
socket interface) so the client logic is testable without a real socket, and
rewrite `rtsp_client.ts`'s read loop on top of `framing.ts`. Retire the
`runVideoLoop` heuristic. Tests: feed adversarial chunks (CRLF inside a payload,
a frame split across two `feed()` calls, an interleaved keepalive response).

**Wave 3 — RTCP + keepalive + session lifecycle (device-independent).**
Agent: add `rtcp.ts` (parse SR; build the empty Receiver Report), wire the
client to **answer channel-1 RTCP with an RR**, add the **20 s OPTIONS
keepalive** with the `Session` id, and tighten `Session`/`TEARDOWN` handling per
Yellowstone. (Note: fix the `length`/`ssrc` shift bugs that exist in
Yellowstone's own `parseRTCPPacket` rather than copying them.)

**Wave 4 — Relay app hardening (device-independent).**
Agent: move state into **per-connection** scope (kill the `firstTs`/`started`
module globals), **serve `frontend/index.html` + `decoder.js`** from the non-WS
branch, add `try/catch` around the `onopen` async chain so failures close the
socket and surface an error.

**Wave 5 — De-duplicate the probes (device-independent).**
Agent: rewrite `probe_transport.ts` / `probe_stream.ts` to import
`@navicoos/rtsp`; delete `scripts/_rtsp.ts`. The probes keep their _measurement_
logic but stop carrying private copies of the protocol.

**Wave 6 — Probe-gated work (BLOCKED on device output).**
Only after you run `deno task probe:transport` / `probe:stream` against
`192.168.0.1:554/screenmirror`:
- If SETUP refuses interleaving → add the **UDP `Deno.DatagramConn` fallback**.
- If any request returns **401** → add `auth.ts` (Basic, then Digest+MD5 via
  `jsr:@std/crypto`).
- If SDP lacks `sprop-parameter-sets` → implement the **in-band SPS/PPS capture**
  fallback `sdp.ts` currently only documents.
- Marker-bit vs timestamp-change delimiting and in-band SPS/PPS frequency from
  the stream probe confirm or adjust the depacketizer defaults.

---

## 4. Sequencing & rationale

Waves 0–5 need **no device** — they're pure robustness/structure work validated
by unit tests and `deno check`/`lint`. They can land while we wait on probe
output. Wave 6 is the only device-dependent piece and splits cleanly along the
exact unknowns the two probes were written to answer (§0 transport precondition,
auth, in-band parameter sets, marker reliability).

Net effect on the repo: from one stubbed package with triplicated protocol code,
to a tested zero-dependency `@navicoos/rtsp` library consumed by a thin relay app
and by the probes — with Yellowstone's framing/RTCP/keepalive/auth architecture
folded in and our four known bugs fixed, without regressing the three places we
parse more correctly than Yellowstone does.

---

## 5. Open questions for you

1. **Layout naming:** `packages/rtsp` + `apps/relay` as above, or flatter
   (`rtsp/` + keep the relay at root)? I lean toward `packages/` + `apps/` since
   you called it a monorepo.
2. **Zero-dependency stance:** keep our hand-rolled SDP (my recommendation), or
   adopt `npm:sdp-transform` like Yellowstone for broader SDP coverage at the
   cost of a dependency in the compiled binary?
3. **Auth scope:** scaffold `auth.ts` now (Basic only) or leave it entirely to
   Wave 6 pending a 401 from the probe? `/screenmirror` may well be open.
4. **Should I start Wave 0–1 now** (device-independent, low-risk) while the probe
   output is pending, or hold everything until you've reviewed this plan?
