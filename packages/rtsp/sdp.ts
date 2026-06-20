// SDP parsing -> StreamConfig. Phase B: faithful port of Yellowstone's
// processConnectionDetails() / RTSPClient DESCRIBE handling via sdp-transform.

import * as transform from "sdp-transform";
import type { MediaDescription } from "sdp-transform";
import type { StreamConfig } from "./types.ts";

/**
 * Parse an SDP body (the DESCRIBE response body) and extract a StreamConfig.
 *
 * Mirrors Yellowstone's RTSPClient.connect() usage:
 *   const { media } = transform.parse(sdpBody)
 *   find the first H264 video media section
 *   const fmtpConfig = transform.parseParams(fmtp.config)
 *   extract sprop-parameter-sets, base64-decode SPS and PPS
 *
 * @param sdpBody  Raw SDP text (DESCRIBE response body).
 * @param baseUrl  RTSP base URL used to resolve relative control URIs.
 */
export function parseSdp(sdpBody: string, baseUrl: string): StreamConfig {
  const { media } = transform.parse(sdpBody);

  // Find the first H264 video media section (faithful to Yellowstone's loop)
  const mediaSource = media.find(
    (m: MediaDescription) => m.type === "video" && m.rtp[0]?.codec === "H264",
  );

  if (!mediaSource) {
    throw new Error("No H264 video media section found in SDP");
  }

  // Resolve control URL — Yellowstone's approach: relative or absolute
  let controlUrl = baseUrl;
  if (mediaSource.control) {
    if (mediaSource.control.toLowerCase().startsWith("rtsp://")) {
      controlUrl = mediaSource.control;
    } else {
      controlUrl = baseUrl.replace(/\/+$/, "") + "/" + mediaSource.control.replace(/^\/+/, "");
    }
  }

  // payloadType and clockRate from the first rtpmap entry
  const rtpEntry = mediaSource.rtp[0];
  const payloadType = rtpEntry?.payload ?? 96;
  const clockRate = rtpEntry?.rate ?? 90000;

  // Build codec string from profile-level-id (fmtp)
  // Yellowstone uses parseParams(fmtp.config) to get sprop-parameter-sets
  const fmtp = mediaSource.fmtp[0];
  if (!fmtp) {
    throw new Error("No fmtp entry in H264 media section");
  }

  const fmtpConfig = transform.parseParams(fmtp.config);
  const splitSpropParameterSets = fmtpConfig["sprop-parameter-sets"]
    .toString()
    .split(",");
  const sps_base64 = splitSpropParameterSets[0];
  const pps_base64 = splitSpropParameterSets[1];

  // Yellowstone: Buffer.from(b64, "base64") — port to atob + Uint8Array
  const sps = Uint8Array.from(atob(sps_base64.trim()), (c) => c.charCodeAt(0));
  const pps = Uint8Array.from(atob(pps_base64.trim()), (c) => c.charCodeAt(0));

  // codec string from profile-level-id
  const profileMatch = fmtp.config.match(/profile-level-id=([0-9a-fA-F]{6})/i);
  const codecString = profileMatch ? `avc1.${profileMatch[1].toLowerCase()}` : "avc1.42001e";

  return {
    controlUrl,
    codecString,
    sps,
    pps,
    payloadType,
    clockRate,
  };
}
