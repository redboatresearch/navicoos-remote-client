# Video pipeline findings + browser touch/button control plan

Handoff doc written 2026-06-19 after getting the Deno relay's video path working
end-to-end against a live B&G/Navico MFD over a WireGuard tunnel. Captures what
we learned debugging the video pipeline and lays out the plan for the next chunk
of work: **in-browser touch/button control** (replacing the legacy Python
`reference-client` control path).

## Current status

- Relay reaches the MFD at `192.168.129.4` through the WireGuard tunnel in the
  Docker container. RTSP handshake, SETUP (TCP interleaved), PLAY all succeed.
- **Video plays in both Firefox and Chrome/Edge.** Confirmed live: the chart
  renders (Lake Michigan / Chicago).
- Four commits landed on `claude/charming-planck-ggb378`:
  - `ad0aa59` — BYOB read-pump buffer-detachment fix (transport.ts)
  - `df84a35` — strip filler NALs + negotiate decoder config
  - `32faeaa` — software-decode fallback + strip SEI + diagnostics

## Video pipeline: what was wrong and what we learned

1. **Transport BYOB bug** (`packages/rtsp/transport.ts`): the TCP/TLS read pump
   reused one `ArrayBuffer` across `reader.read()`. BYOB reads *transfer* (detach)
   the supplied buffer, so after the first chunk the next read got a zero-length
   view → looked like EOF → pump closed mid-handshake → writer lock released →
   next request threw "A writable stream is not associate with the writer." Fix:
   reclaim `value.buffer` each iteration.

2. **The MFD's bitstream is valid** — proven by capturing it through the tunnel
   and decoding with ffmpeg (100 frames, 0 errors). Device is a **GStreamer RTSP
   server**, H.264 **Main 4.0**, `avc1.4d0028`, 90kHz, ~15fps, coded **1280x720**
   with **SAR 12:11 → display 1396x720**. Keyframes roughly every 2–4s. Every
   access unit carries an SEI; every keyframe AU carries a large filler NAL.

3. **The bug was always browser-side, never the stream.** We strip non-VCL NALs
   in `apps/relay/main.ts` (`FILTER_NAL_TYPES = {6 SEI, 7 SPS, 8 PPS, 9 AUD,
   12 filler}`) and carry SPS/PPS out-of-band in the avcC `description`. So the
   browser only ever sees bare VCL slices (types 1/5) + avcC.

4. **Chrome/Edge hardware decode genuinely fails on this stream.** With
   `hardwareAcceleration: "prefer-hardware"`, `isConfigSupported` returns true,
   `configure()` succeeds, then **the very first keyframe throws
   `EncodingError: Decoding error`** (framesOut=0) — even for a clean bare IDR.
   This is the classic WebCodecs footgun: isConfigSupported lies about the
   hardware path. **Fix: on a decode error, rebuild the `VideoDecoder` forcing
   `prefer-software` and resync from the next keyframe.** A decoder is closed
   permanently by an error, so we build a fresh one. Firefox was already on a
   software path and worked once filler was stripped.

### Known issue (follow-up): macroblock garbling

Edge shows intermittent block corruption. Most likely cause: the frontend's
backpressure logic drops delta frames (`decoder.decodeQueueSize > 5 && !isKey`),
and a dropped P-frame corrupts everything until the next keyframe (~2–4s). Worth
revisiting — options: raise/remove the queue threshold for software decode, or
request more frequent keyframes. Not yet investigated.

## Dev / debug workflow (important — not obvious)

The container is `navicoos-relay` (linuxserver/wireguard base + grafted Deno).
`scripts/` is **excluded from the image** (.dockerignore), so to run probes/
captures through the live tunnel:

```sh
# copy ad-hoc scripts into the RUNNING container, then run with container deno
docker cp scripts navicoos-relay:/app/scripts
docker compose exec relay deno run --allow-net /app/scripts/probe_transport.ts 192.168.129.4 554 /screenmirror
docker compose exec relay deno run --allow-net /app/scripts/probe_stream.ts 192.168.129.4 554 /screenmirror

# validate H.264 with ffmpeg INSIDE the container (apk add is ephemeral)
docker compose exec relay sh -c "apk add --no-cache ffmpeg"
docker compose exec relay ffmpeg -v error -i /app/cap.h264 -f null -

# frontend files (decoder.js, index.html) are read fresh per request:
#   just `docker cp` them in — NO restart needed.
# main.ts / packages changes need: docker compose restart relay
```

Patches are currently `docker cp`'d into the container's writable layer (and
committed to git). **A `docker compose up --build` is needed to bake them into
the image** — `down`/`up` without `--build` would lose the cp'd copies.

The relay serves frontend bytes (avcC + per-AU AVCC chunks) that can be replayed
to ffmpeg by reconstructing annex-b (4-byte length prefix → start code, prepend
SPS/PPS). That technique isolated the bug to the browser definitively.

## NEXT: in-browser touch/button control

Decision (user): **reimplement control in the relay** so taps/clicks on the
canvas and on-screen buttons drive the MFD. No more Python `reference-client`.

### Control protocol (verified from `reference-client/navicoos_remote_client/core.py` + `cli.py`)

- **Transport:** TCP to `IP:6633` (remotecontrold), persistent socket, reachable
  through the tunnel (same `192.168.129.0/24` AllowedIPs as RTSP).
- **All packets:** `[uint16 BE payload-length][payload]`. Length excludes itself.
- **Handshake sequence** (do before sending events):
  1. **PING →** `00 06  00 01  44 03 D7 C3` (len=6, opcode=0x0001, magic
     0x4403D7C3). 8 bytes total.
  2. **PING REPLY ←** parse: skip 4 (len+opcode), then `>I 32s 32s 24s` =
     pingid, name(32), model(32), version(24). At payload offset **92**: button
     count (1 byte). At `93 + i*8`: `uint32 btn_index, uint32 keycode` per button.
     Resolution at `93 + count*8`: `uint16 width, uint16 height`. **Keycodes are
     dynamic and discovered here** — buttons can't be sent until this is parsed.
  3. **AUTH →** `struct.pack('>H 6s 32s', 0x0003, mac_bytes, client_name)` then
     length-prefixed. payload = opcode(2)+MAC(6)+name(32)=40 bytes; total 42.
     `client_name` default `'iPad'` (null-padded ASCII). MAC from `--client-id`.
  4. **AUTH ACK ←** expect opcode `0x0004` at bytes [2:4].
- **TOUCH event:** payload `struct.pack('>H I H H B B', 0x1001, timestamp, x, y,
  event_type, touch_count)` = 12 bytes; length-prefixed → 16 total.
  - `timestamp` = `int(monotonic_ms)`; `x,y` absolute pixels in **0..1279 / 0..719**
    (coded 1280x720, **clamped**); `event_type` 0=down, 1=move, 2=up;
    `touch_count` = 1.
- **KEY event:** payload `struct.pack('>H I I', 0x1003, keycode, pressRelease)` =
  10 bytes; length-prefixed → 12 total. Every press sends **two** packets:
  press (1) then release (0). `keycode` comes from the PING REPLY table.
- **Button map** (`BUTTON_MAP` in core.py, index → (key,label)):
  `0x01 Page, 0x02 Menu, 0x03 Zoom In, 0x04 Zoom Out, 0x05 Power, 0x07 Enter,
  0x08 Cancel, 0x09 MOB, 0x0a Goto, 0x0b Mark, 0x0c WheelKey`.
- No sequence numbers, checksums, or keepalives. Device may time out if idle.

### Coordinate mapping (critical)

Touch coords map to the **coded 1280x720**, NOT the displayed 1396x720. In the
browser: take the pointer position relative to the canvas's rendered rect,
normalize to 0..1, multiply by 1280/720, round, clamp to 1279/719. (The Python
client normalized within the video rect then scaled to 1280x720 — same idea.)
Prefer the device-reported resolution from PING REPLY if it differs from
1280x720, but fall back to 1280x720.

### Implementation sketch

- **`packages/rtsp/control.ts`** (new): a `ControlClient` using `TcpTransport`
  (reuse the existing transport!). Methods: `connect()` (does PING/AUTH
  handshake, parses + stores keycodes + resolution), `sendTouch(x,y,type)`,
  `sendKey(keycode, press)` / `pressKey(name)` (sends press+release). Big-endian
  packing via `DataView`.
- **`apps/relay/main.ts`**: open a `ControlClient` per WebSocket connection
  (lazily, like the RTSP client). Add `socket.onmessage` to receive control
  messages **from** the browser (currently the WS is server→client only) and
  forward to the device. Define a small browser→relay message schema, e.g.
  JSON `{t:"touch", x, y, e}` and `{t:"key", name}` — or binary. Expose the
  device keycode table / resolution to the frontend (extend the `config` msg).
  Client MAC via env var (e.g. `CLIENT_ID`, default the user's
  `06:3b:e8:c2:ca:ad`), mirroring how `MFD_IP` is passed.
- **`apps/relay/frontend/`**: pointer event handlers on the canvas
  (pointerdown/move/up → touch down/move/up with coord mapping), plus an
  on-screen button row (Menu, Enter, Cancel, Zoom +/-, Page, Mark, Goto, MOB,
  WheelKey, Power) wired to `sendKey`. Keyboard shortcuts optional (map like
  `MPV_KEY_MAP`).

### Open questions / decisions for next session

- Browser→relay control wire format: JSON vs binary (JSON is simpler; volume is
  low — fine).
- Touch throttling: pointermove fires fast; throttle move events (the Python
  path sent every move). Consider rAF-throttling or min-interval.
- Where the MAC/client-id is configured (env var name + default).
- Whether to surface the device's button labels dynamically (from PING REPLY) or
  hardcode the known set.
