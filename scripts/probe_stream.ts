// probe_stream.ts — interleaved H.264 stream analyzer.
//
// Performs the full TCP-interleaved handshake, then reads the `$`-framed stream
// for a few seconds and reports the empirical facts the depacketizer (spec §3.3)
// and main.ts (§3.5) depend on but that have NOT been validated against a live
// device:
//
//   • which interleaved channels actually appear (0 = RTP video, 1 = RTCP)
//   • RTP payload-type sanity
//   • NAL-type distribution: single / STAP-A / FU-A, and which NAL types ride them
//   • whether SPS(7)/PPS(8)/AUD(9) appear IN-BAND (matters if SDP lacked them)
//   • whether IDR keyframes (type 5) appear, and how often
//   • MARKER-BIT RELIABILITY vs timestamp-change AU delimiting (§3.3 fallback)
//   • RTCP traffic on channel 1 (§4 — does the stream need receiver reports?)
//   • RTP sequence gaps (should be zero over TCP) and rough frame rate
//
// Usage:
//   deno task probe:stream [IP] [PORT] [PATH] [--secs=8]
//   deno run --allow-net scripts/probe_stream.ts 192.168.0.1 554 /screenmirror --secs=10

import { hex, nalTypeName, parseArgs, parseRtp, RtspConn } from "./_rtsp.ts";

function joinUrl(base: string, rel: string): string {
  if (rel.startsWith("rtsp://")) return rel;
  return base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

function controlFromSdp(sdp: string, baseUrl: string): string {
  let inVideo = false;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    if (inVideo && line.startsWith("a=control:")) {
      const c = line.slice("a=control:".length).trim();
      if (c && c !== "*") return joinUrl(baseUrl, c);
    }
  }
  return baseUrl;
}

interface Stats {
  interleavedFrames: number;
  channelCounts: Map<number, number>;
  rtpPackets: number;
  payloadTypes: Set<number>;
  nalCounts: Map<number, number>; // NAL type -> count (effective type, FU-A reconstructed)
  packetizationCounts: { single: number; stapA: number; fuA: number; other: number };
  fuStarts: number;
  fuEnds: number;
  inbandSps: number;
  inbandPps: number;
  inbandAud: number;
  idrNals: number;
  markerSet: number;
  distinctTimestamps: Set<number>;
  tsChanges: number;
  seqGaps: number;
  firstTs: number | null;
  lastTs: number | null;
  rtcpPackets: number;
}

function inspectNal(nal: Uint8Array, s: Stats) {
  if (nal.length === 0) return;
  const t = nal[0] & 0x1f;
  s.nalCounts.set(t, (s.nalCounts.get(t) ?? 0) + 1);
  if (t === 5) s.idrNals++;
  if (t === 7) s.inbandSps++;
  if (t === 8) s.inbandPps++;
  if (t === 9) s.inbandAud++;
}

function handlePayload(payload: Uint8Array, s: Stats) {
  if (payload.length === 0) return;
  const type = payload[0] & 0x1f;
  if (type >= 1 && type <= 23) {
    s.packetizationCounts.single++;
    inspectNal(payload, s);
  } else if (type === 24) { // STAP-A
    s.packetizationCounts.stapA++;
    let off = 1;
    while (off + 2 <= payload.length) {
      const size = (payload[off] << 8) | payload[off + 1];
      off += 2;
      if (off + size > payload.length) break;
      inspectNal(payload.subarray(off, off + size), s);
      off += size;
    }
  } else if (type === 28) { // FU-A
    s.packetizationCounts.fuA++;
    const fuHeader = payload[1];
    const start = (fuHeader & 0x80) !== 0;
    const end = (fuHeader & 0x40) !== 0;
    const origType = fuHeader & 0x1f;
    if (start) {
      s.fuStarts++;
      // Count the reconstructed NAL once, at its start fragment.
      s.nalCounts.set(origType, (s.nalCounts.get(origType) ?? 0) + 1);
      if (origType === 5) s.idrNals++;
      if (origType === 7) s.inbandSps++;
      if (origType === 8) s.inbandPps++;
      if (origType === 9) s.inbandAud++;
    }
    if (end) s.fuEnds++;
  } else {
    s.packetizationCounts.other++;
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((100 * n) / total).toFixed(1)}%`;
}

async function main() {
  const { ip, port, path, rest } = parseArgs(Deno.args);
  const secsArg = rest.find((a) => a.startsWith("--secs="));
  const durationMs = (secsArg ? Number(secsArg.split("=")[1]) : 8) * 1000;

  const conn = new RtspConn({ ip, port, path });
  console.log(`Streaming probe of ${conn.baseUrl} for ${durationMs / 1000}s`);
  await conn.connect();

  await conn.send("OPTIONS", conn.baseUrl);
  if ((await conn.readResponse()).status !== 200) throw new Error("OPTIONS failed");

  await conn.send("DESCRIBE", conn.baseUrl, { Accept: "application/sdp" });
  const desc = await conn.readResponse();
  if (desc.status !== 200) throw new Error(`DESCRIBE failed (${desc.status})`);
  const controlUrl = controlFromSdp(conn.decode(desc.body), conn.baseUrl);

  await conn.send("SETUP", controlUrl, {
    Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
  });
  const setup = await conn.readResponse();
  if (setup.status !== 200) {
    throw new Error(
      `SETUP failed (${setup.status}) — device may be UDP-only. Run probe:transport --udp.`,
    );
  }
  conn.session = (setup.headers.get("session") ?? "").split(";")[0].trim();

  await conn.send("PLAY", conn.baseUrl);
  if ((await conn.readResponse()).status !== 200) throw new Error("PLAY failed");
  console.log("Handshake OK, reading interleaved stream...\n");

  const s: Stats = {
    interleavedFrames: 0,
    channelCounts: new Map(),
    rtpPackets: 0,
    payloadTypes: new Set(),
    nalCounts: new Map(),
    packetizationCounts: { single: 0, stapA: 0, fuA: 0, other: 0 },
    fuStarts: 0,
    fuEnds: 0,
    inbandSps: 0,
    inbandPps: 0,
    inbandAud: 0,
    idrNals: 0,
    markerSet: 0,
    distinctTimestamps: new Set(),
    tsChanges: 0,
    seqGaps: 0,
    firstTs: null,
    lastTs: null,
    rtcpPackets: 0,
  };
  let prevSeq: number | null = null;
  let prevTs: number | null = null;
  let firstSampleLogged = 0;

  const deadline = Date.now() + durationMs;
  const indexOfCrlf = (b: Uint8Array): number => {
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x0d && b[i + 1] === 0x0a) return i;
    return -1;
  };

  loop:
  while (Date.now() < deadline) {
    while (conn.buf.length < 4) {
      if (Date.now() >= deadline) break loop;
      if (!await conn.fill()) break loop;
    }
    if (conn.buf[0] !== 0x24) { // not a '$' frame — tolerate stray RTSP text
      const nl = indexOfCrlf(conn.buf);
      if (nl === -1) {
        if (!await conn.fill()) break;
        continue;
      }
      conn.buf = conn.buf.slice(nl + 2);
      continue;
    }
    const channel = conn.buf[1];
    const len = (conn.buf[2] << 8) | conn.buf[3];
    while (conn.buf.length < 4 + len) {
      if (!await conn.fill()) break loop;
    }
    const packet = conn.buf.subarray(4, 4 + len);
    s.interleavedFrames++;
    s.channelCounts.set(channel, (s.channelCounts.get(channel) ?? 0) + 1);

    if (channel === 0) {
      const rtp = parseRtp(packet);
      s.rtpPackets++;
      s.payloadTypes.add(rtp.payloadType);
      if (rtp.marker) s.markerSet++;
      s.distinctTimestamps.add(rtp.timestamp);
      if (prevTs !== null && rtp.timestamp !== prevTs) s.tsChanges++;
      if (prevSeq !== null) {
        const expectedSeq: number = (prevSeq + 1) & 0xffff;
        if (rtp.seq !== expectedSeq) s.seqGaps++;
      }
      prevSeq = rtp.seq;
      prevTs = rtp.timestamp;
      if (s.firstTs === null) s.firstTs = rtp.timestamp;
      s.lastTs = rtp.timestamp;

      if (firstSampleLogged < 3) {
        const t = rtp.payload[0] & 0x1f;
        console.log(
          `  sample rtp: pt=${rtp.payloadType} seq=${rtp.seq} ts=${rtp.timestamp} ` +
            `marker=${rtp.marker} nal=${t} (${nalTypeName(t)}) ` +
            `head=[${hex(rtp.payload, 4)}]`,
        );
        firstSampleLogged++;
      }
      handlePayload(rtp.payload, s);
    } else if (channel === 1) {
      s.rtcpPackets++;
    }
    conn.buf = conn.buf.slice(4 + len);
  }

  try {
    if (conn.session) await conn.send("TEARDOWN", conn.baseUrl);
  } catch { /* ignore */ }
  conn.close();

  // --- report ---
  const line = (l: string) => console.log(l);
  line(`\n${"═".repeat(72)}`);
  line("STREAM ANALYSIS");
  line("═".repeat(72));
  line(`interleaved frames:   ${s.interleavedFrames}`);
  line(
    `channels seen:        ${
      [...s.channelCounts.entries()].map(([c, n]) => `ch${c}=${n}`).join("  ") || "(none)"
    }`,
  );
  line(`RTP video packets:    ${s.rtpPackets}`);
  line(`RTCP packets (ch1):   ${s.rtcpPackets}`);
  line(`RTP payload types:    ${[...s.payloadTypes].join(", ") || "(none)"}`);
  line(`RTP seq gaps:         ${s.seqGaps}  (TCP should give 0)`);

  line("\nPacketization mode:");
  line(`  single NAL:   ${s.packetizationCounts.single}`);
  line(`  STAP-A:       ${s.packetizationCounts.stapA}`);
  line(`  FU-A:         ${s.packetizationCounts.fuA}  (starts=${s.fuStarts} ends=${s.fuEnds})`);
  line(`  other/unhand: ${s.packetizationCounts.other}`);

  line("\nNAL-type distribution (effective types):");
  for (const [t, n] of [...s.nalCounts.entries()].sort((a, b) => a[0] - b[0])) {
    line(`  ${String(t).padStart(2)} ${nalTypeName(t).padEnd(22)} ${n}`);
  }

  line("\nParameter sets in-band:");
  line(`  SPS(7)=${s.inbandSps}  PPS(8)=${s.inbandPps}  AUD(9)=${s.inbandAud}`);
  line(`  IDR keyframes (type 5 slices): ${s.idrNals}`);

  // marker-bit reliability — compare marker count to access-unit count.
  // distinctTimestamps ≈ number of access units; markerSet ≈ AUs the encoder
  // flagged. If marker count is ~0 or far below AU count, the timestamp-change
  // fallback (§3.3) is load-bearing.
  const aus = s.distinctTimestamps.size;
  line("\nAccess-unit delimiting:");
  line(`  distinct RTP timestamps (~AUs): ${aus}`);
  line(`  packets with marker bit set:    ${s.markerSet}`);
  line(`  timestamp changes:              ${s.tsChanges}`);
  let markerVerdict: string;
  if (s.markerSet === 0) {
    markerVerdict = "❌ marker NEVER set — timestamp-change fallback is REQUIRED (§3.3).";
  } else if (aus > 0 && Math.abs(s.markerSet - aus) <= Math.max(2, aus * 0.1)) {
    markerVerdict = "✅ marker count ≈ AU count — marker bit looks RELIABLE.";
  } else {
    markerVerdict = `⚠️  marker set on ${pct(s.markerSet, aus)} of AUs — partially reliable; ` +
      "keep the timestamp fallback.";
  }
  line(`  >> ${markerVerdict}`);

  // rough frame rate from RTP clock (assume 90kHz unless told otherwise)
  if (s.firstTs !== null && s.lastTs !== null && aus > 1) {
    const spanTicks = (s.lastTs - s.firstTs) >>> 0;
    const spanSec = spanTicks / 90000;
    if (spanSec > 0) {
      line(`\napprox frame rate: ${(aus / spanSec).toFixed(1)} fps (assuming 90kHz)`);
    }
  }

  line(`\n${"═".repeat(72)}`);
  line("WHAT THIS TELLS US about the spec:");
  line("═".repeat(72));
  if (s.rtpPackets === 0) {
    line("  ❌ No RTP video arrived. Either interleaving isn't really working or the");
    line("     device needs RTCP/keepalive before it sends media. Check probe:transport.");
  } else {
    line(`  • Depacketizer must handle: ${
      [
        s.packetizationCounts.single ? "single-NAL" : "",
        s.packetizationCounts.stapA ? "STAP-A" : "",
        s.packetizationCounts.fuA ? "FU-A" : "",
      ].filter(Boolean).join(", ") || "(nothing?)"
    }`);
    line(
      `  • Parameter sets are ${
        s.inbandSps || s.inbandPps ? "ALSO sent in-band" : "NOT sent in-band"
      } — ` +
        `${
          s.inbandSps || s.inbandPps
            ? "in-band capture fallback (§3.2) is viable."
            : "client MUST get SPS/PPS from SDP (§3.2 sprop-parameter-sets)."
        }`,
    );
    line(`  • ${markerVerdict}`);
    line(
      `  • RTCP ${
        s.rtcpPackets ? "IS present on ch1 — server may expect receiver reports (§4)." : "absent."
      }`,
    );
    line(
      `  • IDR keyframes ${
        s.idrNals
          ? "present — keyframe gate (§3.5) will unblock."
          : "NOT seen — keyframe gate would stall; capture longer or check stream."
      }`,
    );
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("probe failed:", e instanceof Error ? e.message : e);
    Deno.exit(1);
  });
}
