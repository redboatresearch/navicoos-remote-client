# navicoos-remote-client — Deno video client

A standalone Deno/TypeScript video client for B&G/Navico marine chartplotters
(MFDs). It opens the MFD's RTSP screen-mirror stream, demuxes H.264 over
interleaved TCP, aggregates access units, and forwards them as AVCC over a
WebSocket to a WebCodecs frontend that decodes to a `<canvas>`.

This replaces the legacy mpv-based video path. The touch/key control protocol
back to the device is handled separately by the legacy Python client (see
[`reference-client/`](./reference-client/)).

> Status: scaffolding only. The modules under `src/` are stubs — see
> `rtsp_client_spec.md` (the spec) for the implementation to fill in.

## Layout

```
.
├── deno.json          # tasks, fmt/lint config, compiler options
├── src/               # Deno client
│   ├── main.ts        # entry point: WebSocket relay + wiring (spec §3.5)
│   ├── rtsp_client.ts # RTSP handshake + interleaved read loop (spec §3.4)
│   ├── rtp.ts         # RTP header parsing (spec §3.1)
│   ├── sdp.ts         # SDP parsing -> StreamConfig (spec §3.2)
│   ├── depacketizer.ts# NAL reassembly -> AVCC access units (spec §3.3)
│   └── types.ts       # shared wire contracts (spec §2)
├── frontend/          # WebCodecs decoder served to webview / remote browser
│   ├── index.html
│   └── decoder.js     # VideoDecoder -> canvas (spec §5)
├── scripts/           # transport/stream verification probes (added later)
└── reference-client/  # legacy Python remote-control + RTSP client
```

## Running the dev relay

The relay connects to the MFD over RTSP and serves a WebSocket on port 8080.

```sh
deno task start <IP>     # defaults to 192.168.0.1 if omitted
```

Point a browser (or the embedded webview) at the relay. Note: `VideoDecoder`
requires a secure context — use `http://localhost` rather than a raw LAN IP
(spec §6).

## Probes

Before relying on the pure-TypeScript transport, verify the device honors RTP
interleaved over the RTSP TCP socket (spec §0):

```sh
deno task probe:transport <IP>   # scripts/probe_transport.ts
deno task probe:stream <IP>      # scripts/probe_stream.ts
```

## Other tasks

```sh
deno task check      # type-check src/*.ts
deno task fmt        # format
deno task lint       # lint
deno task compile    # build a single binary (deno compile --allow-net)
```

## Docker (relay behind a WireGuard tunnel)

To reach a chartplotter on a remote LAN, the relay runs inside a container
based on [`linuxserver/wireguard`](https://docs.linuxserver.io/images/docker-wireguard/).
The container brings up the WireGuard client, and an s6 service runs the Deno
relay alongside it. The relay connects to the MFD lazily — only when a browser
opens the WebSocket — so it reaches the device *through* the tunnel.

```sh
# 1. Drop your WireGuard client config in place (any *.conf name works).
#    Start from wg0.conf.example and fill in your peer's values:
mkdir -p wireguard
cp wg0.conf.example wireguard/wg0.conf
$EDITOR wireguard/wg0.conf

# 2. Set MFD_IP in docker-compose.yml to the chartplotter's address as seen
#    through the tunnel (defaults to 192.168.0.1).

# 3. Build and run:
docker compose up --build

# 4. Open the relay (secure-context requirement — use localhost, not the LAN IP):
open http://localhost:8080
```

### Use a split-tunnel config

The relay only needs to reach the chartplotter — not route all your traffic.
Scope the peer's `AllowedIPs` to the **MFD's subnet**, and make sure `MFD_IP`
falls inside it:

```ini
[Peer]
AllowedIPs = 192.168.0.0/24   # the chartplotter's LAN, NOT 0.0.0.0/0
```

Why this matters: `wg-quick` uses policy-based routing. With a full tunnel
(`0.0.0.0/0`) the only route covering the relay's *replies to your browser* is
the tunnel's default route, so the relay's `:8080` becomes unreachable from
other machines on your LAN (it still works from `localhost` on the Docker
host). A split tunnel adds a route only for the MFD subnet via `wg0` and leaves
everything else on `eth0`, so the port stays reachable everywhere. This was
verified against the container: `192.168.0.1` routes via `wg0`, `1.1.1.1` stays
on `eth0`. See [`wg0.conf.example`](./wg0.conf.example).

The `wireguard/` directory and any `*.conf` files are git-ignored and excluded
from the build context — your keys never end up in the image. The config is
mounted read-only at `/config/wg_confs/` at runtime. To target a different
device without rebuilding, override the env var:

```sh
MFD_IP=10.0.0.5 docker compose up --build   # or edit docker-compose.yml
```

## Legacy Python client

The original native macOS remote display + control client lives in
[`reference-client/`](./reference-client/). It remains the reference for the
control protocol (`core.py`) and is unaffected by this Deno project.
