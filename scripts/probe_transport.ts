// probe_transport.ts — RTSP handshake + transport negotiation probe.
//
// Answers the spec §0 precondition: does the MFD honor RTP interleaved over the
// RTSP TCP socket (Transport: RTP/AVP/TCP;unicast;interleaved=0-1), or is it
// UDP-only? Also dumps the SDP and reports whether the parameter sets and
// profile-level-id needed by sdp.ts (§3.2) are present.
//
// Usage:
//   deno task probe:transport [IP] [PORT] [PATH] [--udp]
//   deno run --allow-net scripts/probe_transport.ts 192.168.0.1 554 /screenmirror
//
//   --udp   also attempt a UDP SETUP for comparison (reports the device's
//           Transport response; no datagram socket is actually opened).

import { parseArgs, RtspConn } from "./_rtsp.ts";

function rule(label = "") {
  console.log(`\n${"─".repeat(8)} ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
}

function dumpHeaders(headers: Map<string, string>) {
  for (const [k, v] of headers) console.log(`    ${k}: ${v}`);
}

interface SdpFacts {
  hasVideo: boolean;
  control: string | null;
  rtpmap: string | null;
  payloadType: number | null;
  clockRate: number | null;
  hasSprop: boolean;
  hasProfileLevelId: boolean;
  fmtp: string | null;
}

function analyzeSdp(sdp: string): SdpFacts {
  const f: SdpFacts = {
    hasVideo: false,
    control: null,
    rtpmap: null,
    payloadType: null,
    clockRate: null,
    hasSprop: false,
    hasProfileLevelId: false,
    fmtp: null,
  };
  let inVideo = false;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    if (inVideo && line.startsWith("m=video")) f.hasVideo = true;
    if (!inVideo && !line.startsWith("m=")) continue;
    if (line.startsWith("a=control:")) f.control = line.slice("a=control:".length).trim();
    else if (line.startsWith("a=rtpmap:")) {
      f.rtpmap = line.slice("a=rtpmap:".length).trim();
      const m = line.match(/a=rtpmap:(\d+)\s+\S+\/(\d+)/);
      if (m) {
        f.payloadType = +m[1];
        f.clockRate = +m[2];
      }
    } else if (line.startsWith("a=fmtp:")) {
      f.fmtp = line;
      if (/sprop-parameter-sets=/.test(line)) f.hasSprop = true;
      if (/profile-level-id=[0-9a-fA-F]{6}/.test(line)) f.hasProfileLevelId = true;
    }
  }
  return f;
}

function joinUrl(base: string, rel: string): string {
  if (rel.startsWith("rtsp://")) return rel;
  return base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

async function main() {
  const { ip, port, path, rest } = parseArgs(Deno.args);
  const tryUdp = rest.includes("--udp");
  const conn = new RtspConn({ ip, port, path });

  console.log(`Probing ${conn.baseUrl}`);
  await conn.connect();

  // --- OPTIONS ---
  rule("OPTIONS");
  await conn.send("OPTIONS", conn.baseUrl);
  const opt = await conn.readResponse();
  console.log(`  status: ${opt.status} ${opt.reason}`);
  dumpHeaders(opt.headers);
  if (opt.headers.has("public")) {
    console.log(`  >> supported methods: ${opt.headers.get("public")}`);
  }

  // --- DESCRIBE ---
  rule("DESCRIBE");
  await conn.send("DESCRIBE", conn.baseUrl, { Accept: "application/sdp" });
  const desc = await conn.readResponse();
  console.log(`  status: ${desc.status} ${desc.reason}`);
  dumpHeaders(desc.headers);
  const sdpText = conn.decode(desc.body);
  rule("SDP (raw)");
  console.log(sdpText.trimEnd());

  const facts = analyzeSdp(sdpText);
  rule("SDP analysis");
  console.log(`  m=video present:        ${facts.hasVideo}`);
  console.log(`  a=control:              ${facts.control ?? "(none)"}`);
  console.log(`  a=rtpmap:               ${facts.rtpmap ?? "(none)"}`);
  console.log(`  payloadType / clock:    ${facts.payloadType ?? "?"} / ${facts.clockRate ?? "?"}`);
  console.log(`  sprop-parameter-sets:   ${facts.hasSprop ? "PRESENT" : "MISSING"}`);
  console.log(`  profile-level-id:       ${facts.hasProfileLevelId ? "PRESENT" : "MISSING"}`);
  if (!facts.hasSprop || !facts.hasProfileLevelId) {
    console.log(
      `  >> NOTE: sdp.ts (§3.2) throws when these are missing; the client must`,
    );
    console.log(`     capture SPS/PPS in-band instead. probe_stream.ts checks for that.`);
  }

  const controlUrl = facts.control && facts.control !== "*"
    ? joinUrl(conn.baseUrl, facts.control)
    : conn.baseUrl;
  console.log(`  resolved control URL:   ${controlUrl}`);

  // --- SETUP (TCP interleaved) — the precondition under test ---
  rule("SETUP  (RTP/AVP/TCP interleaved)");
  await conn.send("SETUP", controlUrl, {
    Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
  });
  const setup = await conn.readResponse();
  console.log(`  status: ${setup.status} ${setup.reason}`);
  dumpHeaders(setup.headers);
  const tcpOk = setup.status === 200;
  const transportHdr = setup.headers.get("transport") ?? "";
  const interleaved = /interleaved=/.test(transportHdr);
  if (tcpOk) {
    conn.session = (setup.headers.get("session") ?? "").split(";")[0].trim();
    console.log(`  >> session id: ${conn.session || "(none returned!)"}`);
    console.log(`  >> Transport echoed interleaved channels: ${interleaved ? "YES" : "NO"}`);
  }

  // --- PLAY (only if TCP SETUP succeeded) ---
  let playOk = false;
  if (tcpOk) {
    rule("PLAY");
    await conn.send("PLAY", conn.baseUrl);
    const play = await conn.readResponse();
    console.log(`  status: ${play.status} ${play.reason}`);
    dumpHeaders(play.headers);
    playOk = play.status === 200;
  }

  // --- optional UDP comparison ---
  if (tryUdp) {
    rule("SETUP  (RTP/AVP UDP, comparison)");
    // Fresh connection so the prior session state doesn't interfere.
    const udpConn = new RtspConn({ ip, port, path });
    try {
      await udpConn.connect();
      await udpConn.send("OPTIONS", udpConn.baseUrl);
      await udpConn.readResponse();
      await udpConn.send("SETUP", controlUrl, {
        Transport: "RTP/AVP;unicast;client_port=50000-50001",
      });
      const udp = await udpConn.readResponse();
      console.log(`  status: ${udp.status} ${udp.reason}`);
      dumpHeaders(udp.headers);
      console.log(
        `  >> UDP SETUP ${udp.status === 200 ? "ACCEPTED" : "REFUSED"}` +
          (udp.headers.has("transport") ? ` — Transport: ${udp.headers.get("transport")}` : ""),
      );
    } catch (e) {
      console.log(`  UDP probe error: ${e instanceof Error ? e.message : e}`);
    } finally {
      try {
        await udpConn.send("TEARDOWN", udpConn.baseUrl);
      } catch { /* ignore */ }
      udpConn.close();
    }
  }

  // --- TEARDOWN ---
  try {
    if (conn.session) await conn.send("TEARDOWN", conn.baseUrl);
  } catch { /* ignore */ }
  conn.close();

  // --- verdict ---
  rule("VERDICT");
  if (tcpOk && interleaved && playOk) {
    console.log("  ✅ TCP RTP-interleaving is supported. Build the pure-TS path (spec §1-§5).");
    console.log(
      "     Next: run  deno task probe:stream  to validate the depacketizer assumptions.",
    );
  } else if (tcpOk && playOk) {
    console.log("  ⚠️  SETUP/PLAY succeeded but the Transport header did NOT echo interleaved");
    console.log("     channels. Inspect the SETUP Transport header above; the device may be");
    console.log("     using a different channel mapping. Run probe:stream to see what arrives.");
  } else if (tcpOk && !playOk) {
    console.log("  ⚠️  SETUP succeeded but PLAY did not. Inspect the PLAY response above.");
  } else {
    console.log("  ❌ TCP interleaving was REFUSED (non-200 SETUP). Per spec §0 this is the");
    console.log("     trigger for the UDP fallback path (Deno.listenDatagram). Re-run with");
    console.log("     --udp to confirm the device accepts a UDP SETUP.");
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("probe failed:", e instanceof Error ? e.message : e);
    Deno.exit(1);
  });
}
