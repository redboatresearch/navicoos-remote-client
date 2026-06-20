# navicoos-remote-client: Deno RTSP->WebSocket relay running behind a
# WireGuard tunnel so it can reach a B&G/Navico chartplotter on a remote LAN.
#
# Base image is linuxserver/wireguard (s6-overlay v3). We graft the Deno
# binary in, copy the workspace, pre-cache deps, and register the relay as an
# s6 longrun service that starts alongside the WireGuard client.

# Pin the Deno version. linuxserver/wireguard is Alpine (musl), so we can't use
# the glibc deno:bin image — we pull from deno:alpine, which ships the deno
# binary plus a self-contained glibc shim it links against.
FROM denoland/deno:alpine-2.8.3 AS deno

FROM linuxserver/wireguard:latest

# --- Deno runtime -----------------------------------------------------------
# linuxserver/wireguard is Alpine/musl; deno is a glibc binary whose RPATH the
# deno:alpine image patches to /usr/local/lib/glibc. We reproduce that image's
# layout exactly (see denoland/deno_docker alpine.dockerfile): the isolated
# glibc libs, the glibc loader in /lib, and the /lib64 loader symlink that the
# binary's ELF interpreter path needs (matters on x86_64; harmless on arm64).
COPY --from=deno /bin/deno /usr/local/bin/deno
COPY --from=deno /usr/local/lib/glibc/ /usr/local/lib/glibc/
COPY --from=deno /lib/ld-linux-* /lib/
RUN mkdir -p /lib64 && ln -sf /usr/local/lib/glibc/ld-linux-* /lib64/

# Keep Deno's module cache inside the image (services run as root here).
ENV DENO_DIR=/app/.deno-cache \
    MFD_IP=192.168.0.1

# --- Application ------------------------------------------------------------
WORKDIR /app
# Copy the whole workspace: the root deno.json defines the workspace that
# resolves the @navicoos/rtsp import, and main.ts reads ./frontend/* relative
# to itself at runtime.
COPY deno.json deno.lock ./
COPY packages ./packages
COPY apps ./apps

# Pre-cache remote deps at build time so first connect isn't a download.
RUN deno cache apps/relay/main.ts

# --- s6 service -------------------------------------------------------------
# docker/root/ mirrors the container filesystem: it drops the relay longrun
# service into /etc/s6-overlay/s6-rc.d and registers it in the user bundle.
COPY docker/root/ /
RUN chmod +x /etc/s6-overlay/s6-rc.d/deno-relay/run

# Relay HTTP/WebSocket port.
EXPOSE 8080
