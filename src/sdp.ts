// SDP parsing -> StreamConfig. Spec §3.2.

import type { StreamConfig } from "./types.ts";

function joinUrl(base: string, rel: string): string {
  if (rel.startsWith("rtsp://")) return rel;
  return base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

export function parseSdp(sdp: string, baseUrl: string): StreamConfig {
  let controlUrl = baseUrl;
  let fmtp = "";
  let payloadType = 96;
  let clockRate = 90000;
  let inVideo = false;

  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    if (!inVideo && !line.startsWith("m=")) continue;

    if (line.startsWith("a=control:")) {
      const c = line.slice("a=control:".length).trim();
      if (c && c !== "*") controlUrl = joinUrl(baseUrl, c);
    } else if (line.startsWith("a=rtpmap:")) {
      const m = line.match(/a=rtpmap:(\d+)\s+\S+\/(\d+)/);
      if (m) {
        payloadType = +m[1];
        clockRate = +m[2];
      }
    } else if (line.startsWith("a=fmtp:")) {
      fmtp = line;
    }
  }

  const { sps, pps, codecString } = parseFmtp(fmtp);
  return { controlUrl, codecString, sps, pps, payloadType, clockRate };
}

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
}

function parseFmtp(fmtp: string): { sps: Uint8Array; pps: Uint8Array; codecString: string } {
  const sprop = fmtp.match(/sprop-parameter-sets=([^;\s]+)/);
  const profile = fmtp.match(/profile-level-id=([0-9a-fA-F]{6})/);
  if (!sprop || !profile) {
    // Device didn't advertise parameter sets in SDP. Caller must capture the
    // first in-band SPS (type 7) and PPS (type 8) from the stream and build
    // the codec string from SPS bytes 1..3 instead.
    throw new Error("SDP missing sprop-parameter-sets / profile-level-id");
  }
  const [spsB64, ppsB64] = sprop[1].split(",");
  return {
    sps: b64(spsB64),
    pps: b64(ppsB64),
    codecString: `avc1.${profile[1].toLowerCase()}`,
  };
}
