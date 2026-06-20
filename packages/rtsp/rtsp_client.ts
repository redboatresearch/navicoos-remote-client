/// <reference lib="deno.unstable" />
// Phase B: faithful Deno port of Yellowstone's RTSPClient.
// Mechanical Node→Deno substitution only — quirks preserved verbatim.
// RFC corrections come in Phase C (a later commit).
//
// Node→Deno substitution table (§1 of plans/yellowstone-incorporation.md):
//   net.connect / tls.connect  → TcpTransport / TlsTransport (./transport.ts)
//   dgram.Socket               → UdpReceiver + sendUdpOnce (./transport.ts)
//   EventEmitter               → EventEmitter shim (./emitter.ts)
//   Buffer                     → Uint8Array + DataView
//   url.parse                  → WHATWG new URL()
//   crypto hash                → generateAuthString (./auth.ts) — async

import { EventEmitter } from "./emitter.ts";
import {
  sendUdpOnce,
  type StreamTransport,
  TcpTransport,
  TlsTransport,
  UdpReceiver,
} from "./transport.ts";
import { generateSSRC, parseRTPPacket } from "./rtp.ts";
import { emptyReceiverReport, parseRTCPPacket } from "./rtcp.ts";
import { type AuthOptions, generateAuthString, parseAuthChallenge } from "./auth.ts";
import { parseSdp } from "./sdp.ts";
import { type AccessUnitMeta, H264Depacketizer } from "./depacketizer.ts";
import type { StreamConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants — preserved from Yellowstone
// ---------------------------------------------------------------------------

const RTP_AVP = "RTP/AVP";
const RTP_AVPF = "RTP/AVPF";

const STATUS_OK = 200;
const STATUS_UNAUTH = 401;

const WWW_AUTH = "WWW-Authenticate";

// Phase B: faithful to Yellowstone (corrected in Phase C)
// WWW_AUTH_REGEX is preserved verbatim — exact same regex from Yellowstone.
// Parsing is delegated to parseAuthChallenge() in auth.ts; prefixed _  to satisfy lint.
const _WWW_AUTH_REGEX = new RegExp(
  '([a-zA-Z]+)\\s*=\\s*"?((?<=").*?(?=")|.*?(?=\\s*,?\\s*[a-zA-Z]+\\s*=)|.+[^\\s])',
  "g",
);

// ---------------------------------------------------------------------------
// ReadStates enum — preserved from Yellowstone
// ---------------------------------------------------------------------------

enum ReadStates {
  SEARCHING,
  READING_RTSP_HEADER,
  READING_RTSP_PAYLOAD,
  READING_RAW_PACKET_SIZE,
  READING_RAW_PACKET,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Connection = "udp" | "tcp";

type Headers = {
  [key: string]: string | number | undefined;
  Session?: string;
  Location?: string;
  CSeq?: number;
  "WWW-Authenticate"?: string;
  Transport?: string;
  Unsupported?: string;
};

// Detail mirrors Yellowstone's inner Detail type. Stripped of sdp-transform's
// MediaDescription (which we do not import here) and Transport type.
interface Detail {
  codec: string;
  mediaSource: {
    type: string;
    port: number;
    protocol: string;
    payloads?: string | undefined;
    direction?: string;
    control?: string;
    // rtp entries from sdp-transform
    rtp: Array<{ codec: string; payload: number; rate?: number }>;
    fmtp: Array<{ payload: number; config: string }>;
  };
  transport: Record<string, string>;
  isH264: boolean;
  rtpChannel: number;
  rtcpChannel: number;

  // Cache any optional RTCP Sender Report values (used to calculate Wall Clock Time)
  sr_ntpMSW?: number;
  sr_ntpLSW?: number;
  sr_rtptimestamp?: number;
}

// ---------------------------------------------------------------------------
// parseTransport — port of Yellowstone's util.parseTransport
// Parses the Transport: header into protocol + key=value parameters.
// ---------------------------------------------------------------------------

function parseTransport(transportHeader: string): {
  protocol: string;
  parameters: Record<string, string>;
} {
  const parts = transportHeader.split(";");
  const protocol = parts[0].trim();
  const parameters: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) {
      parameters[parts[i].trim()] = "";
    } else {
      const key = parts[i].substring(0, eq).trim();
      const val = parts[i].substring(eq + 1).trim();
      parameters[key] = val;
    }
  }
  return { protocol, parameters };
}

// ---------------------------------------------------------------------------
// RtspClient — faithful Deno port of Yellowstone's RTSPClient
// ---------------------------------------------------------------------------

export class RtspClient extends EventEmitter {
  username: string;
  password: string;
  headers: { [key: string]: string };

  isConnected = false;
  closed = false;

  _url?: string;
  _transport?: StreamTransport;
  _cSeq = 0;
  _unsupportedExtensions?: string[];
  _authOpions?: AuthOptions; // Phase B: faithful to Yellowstone's typo (_authOpions)
  _session?: string;
  _keepAliveID?: number; // Phase B: faithful to Yellowstone (NodeJS.Timeout → number for Deno)
  _nextFreeInterleavedChannel = 0;
  _nextFreeUDPPort = 5000;

  readState: ReadStates = ReadStates.SEARCHING;

  // Used as a cache for the data stream.
  // Phase B: faithful to Yellowstone — messageBytes is number[]
  messageBytes: number[] = [];

  // Used for parsing RTSP responses.
  rtspContentLength = 0;
  rtspStatusLine = "";
  rtspHeaders: Headers = {};

  // Used for parsing RTP/RTCP responses.
  rtspPacketLength = 0;
  // Phase B: faithful to Yellowstone — rtspPacket is Uint8Array (Buffer → Uint8Array)
  rtspPacket: Uint8Array = new Uint8Array(0);
  rtspPacketPointer = 0;

  clientSSRC = generateSSRC();
  setupResult: Array<Detail> = [];

  // Depacketizer — wired during connect() for the H264 video channel.
  private _depacketizer?: H264Depacketizer;

  // onAccessUnit callback — the stable public contract.
  // Registration: set client.onAccessUnit = (nals, meta) => {...} before connect().
  onAccessUnit?: (nals: Uint8Array[], meta: AccessUnitMeta) => void;

  // Wall-clock NTP base date — preserved from Yellowstone
  ntpBaseDate_ms = new Date("1900/1/1").getTime();

  constructor(
    hostname: string,
    port: number,
    path: string,
    options?: {
      username?: string;
      password?: string;
      headers?: { [key: string]: string };
    },
  ) {
    super();

    this.username = options?.username ?? "";
    this.password = options?.password ?? "";
    this.headers = {
      ...(options?.headers ?? {}),
      "User-Agent": "yellowstone/3.x",
    };

    // Build _url from parts (WHATWG URL, not url.parse)
    const proto = "rtsp";
    const portStr = port !== 554 ? `:${port}` : "";
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    this._url = `${proto}://${hostname}${portStr}${cleanPath}`;
  }

  // -------------------------------------------------------------------------
  // _netConnect — port of Yellowstone's _netConnect.
  // Sets this._transport, starts the read pump, wires close/error → events.
  // -------------------------------------------------------------------------

  _netConnect(
    hostname: string,
    port: number,
    secure = false,
  ): Promise<this> {
    return new Promise((resolve, reject) => {
      const transport: StreamTransport = secure ? new TlsTransport() : new TcpTransport();

      const doConnect = async () => {
        try {
          if (secure) {
            await (transport as TlsTransport).connect(hostname, port);
          } else {
            await (transport as TcpTransport).connect(hostname, port);
          }

          this.isConnected = true;
          this._transport = transport;

          // Wire the response listener for REDIRECT / ANNOUNCE
          const responseListener = (responseName: string, headers: Headers) => {
            const name = (responseName as string).split(" ")[0];

            if (name.indexOf("RTSP/") === 0) {
              return;
            }

            if (name === "REDIRECT" || name === "ANNOUNCE") {
              this.respond("200 OK", { CSeq: headers.CSeq });
            }

            if (name === "REDIRECT" && headers.Location) {
              this.close();
              // Phase B: faithful to Yellowstone — reconnect on redirect
              this._reconnect(headers.Location as string);
            }
          };

          this.on("response", responseListener as (...args: unknown[]) => void);

          // Start the read pump — feeds _onData state machine
          transport.listen(
            (chunk: Uint8Array) => {
              this._onData(chunk);
            },
            () => {
              // close callback
              this.emit("close");
              this.close(true);
            },
            (err: unknown) => {
              this.emit("error", err);
            },
          );

          resolve(this);
        } catch (err) {
          reject(err);
        }
      };

      doConnect();
    });
  }

  // _reconnect is called on REDIRECT — mirrors Yellowstone's this.connect(location)
  private _reconnect(url: string): void {
    // Fire-and-forget, matching Yellowstone behavior
    this.connect(url).catch((err) => this.emit("error", err));
  }

  // -------------------------------------------------------------------------
  // connect — port of Yellowstone's connect(url, options)
  //
  // Returns StreamConfig (the SDP-derived config) instead of Detail[].
  // Wire up the H264Depacketizer for the video channel here.
  // -------------------------------------------------------------------------

  async connect(
    url?: string,
    {
      keepAlive = true,
      connection = "udp" as Connection,
      secure = false,
    }: { keepAlive?: boolean; connection?: Connection; secure?: boolean } = {},
  ): Promise<StreamConfig> {
    if (url) {
      this._url = url;
    }
    if (!this._url) throw new Error("No URL provided to connect()");

    const parsed = new URL(this._url);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port || "554");

    await this._netConnect(hostname, port, secure);
    await this.request("OPTIONS");

    const describeRes = await this.request("DESCRIBE", {
      Accept: "application/sdp",
    });
    if (!describeRes || !describeRes.mediaHeaders) {
      throw new Error(
        "No media headers on DESCRIBE; RTSP server is broken (sanity check)",
      );
    }

    // Parse SDP via our sdp.ts module (mirrors Yellowstone's sdp-transform usage)
    const sdpBody = describeRes.mediaHeaders.join("\n");
    const streamConfig = parseSdp(sdpBody, this._url);

    // Wire the H264Depacketizer using the onAccessUnit callback
    this._depacketizer = new H264Depacketizer((nals, meta) => {
      this.onAccessUnit?.(nals, meta);
      // Also re-emit as event (faithful to Yellowstone's event-based shape)
      this.emit("accessUnit", nals, meta);
    });

    // -----------------------------------------------------------------------
    // SETUP — port of Yellowstone's per-media SETUP loop.
    // We scope to H264 video only (per §1 scope decision in the plan).
    // -----------------------------------------------------------------------

    // Phase B: faithful to Yellowstone — build Details array for each stream SETUP
    const details: Detail[] = [];

    // Parse the SDP via sdp-transform to get media array (faithful to Yellowstone)
    // Re-use the raw mediaHeaders we already have
    const { media } = await import("sdp-transform").then((m) => ({
      media: m.parse(describeRes.mediaHeaders!.join("\r\n")).media,
    }));

    let hasVideo = false;
    let hasAudio = false;
    let hasMetaData = false;
    let hasBackchannel = false;

    for (let x = 0; x < media.length; x++) {
      let needSetup = false;
      let codec = "";
      const mediaSource = media[x] as Detail["mediaSource"];

      // Phase B: faithful to Yellowstone (Wowza does not send direction)
      if (mediaSource.direction === undefined) mediaSource.direction = "sendrecv";

      if (
        mediaSource.type === "video" &&
        mediaSource.protocol === RTP_AVP &&
        mediaSource.rtp[0].codec === "H264"
      ) {
        this.emit("log", "H264 Video Stream Found in SDP", "");
        if (hasVideo === false) {
          needSetup = true;
          hasVideo = true;
          codec = "H264";
        }
      }

      if (
        mediaSource.type === "video" &&
        mediaSource.protocol === RTP_AVP &&
        mediaSource.rtp[0].codec === "H265"
      ) {
        this.emit("log", "H265 Video Stream Found in SDP", "");
        if (hasVideo === false) {
          needSetup = true;
          hasVideo = true;
          codec = "H265";
        }
      }

      if (
        mediaSource.type === "video" &&
        mediaSource.protocol === RTP_AVP &&
        mediaSource.rtp[0].codec === "H266"
      ) {
        this.emit("log", "H266 Video Stream Found in SDP", "");
        if (hasVideo === false) {
          needSetup = true;
          hasVideo = true;
          codec = "H266";
        }
      }

      if (
        mediaSource.type === "video" &&
        (mediaSource.protocol === RTP_AVP || mediaSource.protocol === RTP_AVPF) &&
        mediaSource.rtp[0].codec === "AV1"
      ) {
        this.emit("log", "AV1 Video Stream Found in SDP", "");
        if (hasVideo === false) {
          needSetup = true;
          hasVideo = true;
          codec = "AV1";
        }
      }

      if (
        mediaSource.type === "audio" &&
        (mediaSource.direction === "recvonly" || mediaSource.direction === "sendrecv") &&
        mediaSource.protocol === RTP_AVP &&
        mediaSource.rtp[0].codec.toLowerCase() === "mpeg4-generic" &&
        mediaSource.fmtp[0].config.includes("AAC")
      ) {
        this.emit("log", "AAC Audio Stream Found in SDP", "");
        if (hasAudio === false) {
          needSetup = true;
          hasAudio = true;
          codec = "AAC";
        }
      }

      if (
        mediaSource.type === "audio" &&
        mediaSource.direction === "sendonly" &&
        mediaSource.protocol === RTP_AVP
      ) {
        this.emit("log", "Audio backchannel Found in SDP", "");
        if (hasBackchannel === false) {
          needSetup = true;
          hasBackchannel = true;
          codec = mediaSource.rtp[0].codec;
        }
      }

      if (
        mediaSource.type === "application" &&
        mediaSource.protocol === RTP_AVP &&
        mediaSource.rtp[0].codec.toLowerCase() === "vnd.onvif.metadata"
      ) {
        this.emit("log", "ONVIF Meta Data Found in SDP", "");
        if (hasMetaData === false) {
          needSetup = true;
          hasMetaData = true;
          codec = "vnd.onvif.metadata";
        }
      }

      if (needSetup) {
        // Resolve stream URL — faithful to Yellowstone
        let streamurl = "";
        if (mediaSource.control) {
          if (mediaSource.control.toLowerCase().startsWith("rtsp://")) {
            streamurl = mediaSource.control;
          } else {
            streamurl = this._url + "/" + mediaSource.control;
          }
        }

        let setupRes;
        let rtpChannel: number;
        let rtcpChannel: number;
        let rtpReceiver: UdpReceiver | null = null;
        let rtcpReceiver: UdpReceiver | null = null;

        if (connection === "udp") {
          // Phase B: faithful to Yellowstone — even/odd UDP port pair
          rtpChannel = this._nextFreeUDPPort;
          rtcpChannel = this._nextFreeUDPPort + 1;
          this._nextFreeUDPPort += 2;

          const rtpPort = rtpChannel;
          rtpReceiver = new UdpReceiver(rtpPort);

          const rtcpPort = rtcpChannel;
          rtcpReceiver = new UdpReceiver(rtcpPort);

          // Bind both UDP sockets (synchronous in Deno, mirrors Yellowstone's await)
          rtpReceiver.bind();
          rtcpReceiver.bind();

          // Wire RTP listener
          rtpReceiver.listen((buf: Uint8Array) => {
            const packet = parseRTPPacket(buf);

            // Wall clock time
            const detail = this.setupResult.find((item) => item.rtpChannel === rtpChannel);
            if (detail !== undefined) packet.wallclockTime = this.GetWallClockTime(packet, detail);

            this.emit("data", rtpPort, packet.payload, packet);

            // Feed H264 depacketizer for video channel
            if (codec === "H264" && this._depacketizer) {
              this._depacketizer.processRTPPacket(packet);
            }
          });

          // Wire RTCP listener
          rtcpReceiver.listen((buf: Uint8Array, remoteAddr: Deno.NetAddr) => {
            const packet = parseRTCPPacket(buf);

            // Cache Sender Report NTP data
            if (packet.packetType === 200 && packet.senderReport !== undefined) {
              const detail = this.setupResult.find(
                (item) => item.rtcpChannel === rtcpChannel,
              );
              if (detail !== undefined) {
                detail.sr_ntpMSW = packet.senderReport.ntpTimestampMSW;
                detail.sr_ntpLSW = packet.senderReport.ntpTimestampLSW;
                detail.sr_rtptimestamp = packet.senderReport.rtpTimestamp;
              }
            }

            this.emit("controlData", rtcpPort, packet);

            const receiver_report = emptyReceiverReport(this.clientSSRC);
            const netAddr = remoteAddr as Deno.NetAddr;
            sendUdpOnce(netAddr.hostname, netAddr.port, receiver_report).catch(() => {});
          });

          const setupHeader: Headers = {
            Transport: `RTP/AVP;unicast;client_port=${rtpPort}-${rtcpPort}`,
          };
          if (this._session) Object.assign(setupHeader, { Session: this._session });
          setupRes = await this.request("SETUP", setupHeader, streamurl);
        } else if (connection === "tcp") {
          // Phase B: faithful to Yellowstone — interleaved channels
          rtpChannel = this._nextFreeInterleavedChannel;
          rtcpChannel = this._nextFreeInterleavedChannel + 1;
          this._nextFreeInterleavedChannel += 2;

          const setupHeader: Headers = {
            Transport: `RTP/AVP/TCP;interleaved=${rtpChannel}-${rtcpChannel}`,
          };
          if (this._session) Object.assign(setupHeader, { Session: this._session });
          setupRes = await this.request("SETUP", setupHeader, streamurl);
        } else {
          throw new Error(
            `Connection parameter to RtspClient#connect is ${connection}, not udp or tcp!`,
          );
        }

        if (!setupRes) {
          throw new Error("No SETUP response; RTSP server is broken (sanity check)");
        }

        const { headers } = setupRes;

        if (!headers.Transport) {
          throw new Error(
            "No Transport header on SETUP; RTSP server is broken (sanity check)",
          );
        }

        const transport = parseTransport(headers.Transport as string);
        if (
          transport.protocol !== "RTP/AVP/TCP" &&
          transport.protocol !== "RTP/AVP" &&
          transport.protocol !== "RTP/AVP/UDP"
        ) {
          throw new Error(
            "Only RTSP servers supporting RTP/AVP or RTP/AVP/UDP or RTP/AVP/TCP are supported at this time.",
          );
        }

        // Patch from zoolyka: NAT hole-punch for UDP
        // Phase B: faithful to Yellowstone — send empty UDP packets to open NAT
        if (
          connection === "udp" &&
          transport &&
          rtpReceiver !== null &&
          rtcpReceiver !== null
        ) {
          const serverPorts = (transport.parameters["server_port"] ?? "").split("-");
          await rtpReceiver.send(
            new Uint8Array(0),
            hostname,
            Number(serverPorts[0]),
          );
          await rtcpReceiver.send(
            new Uint8Array(0),
            hostname,
            Number(serverPorts[1]),
          );
        }

        if (headers.Unsupported) {
          this._unsupportedExtensions = (headers.Unsupported as string).split(",");
        }

        if (headers.Session) {
          this._session = (headers.Session as string).split(";")[0];
        }

        const detail: Detail = {
          codec,
          mediaSource: mediaSource as Detail["mediaSource"],
          transport: transport.parameters,
          isH264: codec === "H264",
          rtpChannel,
          rtcpChannel,
        };

        details.push(detail);
      } // end if (needSetup)
    } // end for loop

    if (keepAlive) {
      // Phase B: faithful to Yellowstone — 20-second OPTIONS keepalive timer
      // Deno's setInterval returns a number (not NodeJS.Timeout), matching the field type.
      this._keepAliveID = setInterval(() => {
        this.request("OPTIONS", { Session: this._session });
      }, 20 * 1000) as unknown as number;
    }

    this.setupResult = details;

    await this.request("PLAY", { Session: this._session });

    return streamConfig;
  }

  // -------------------------------------------------------------------------
  // request — port of Yellowstone's request()
  // Now async because generateAuthString is async (Deno crypto).
  // -------------------------------------------------------------------------

  async request(
    requestName: string,
    headersParam: Headers = {},
    url?: string,
  ): Promise<{ headers: Headers; mediaHeaders?: string[] } | void> {
    if (!this._transport) {
      return;
    }

    if (!url) {
      url = this._url;
    }

    const id = ++this._cSeq;
    // Phase B: faithful to Yellowstone — mutable string concatenation
    let req = `${requestName} ${url} RTSP/1.0\r\nCSeq: ${id}\r\n`;

    const headers: Headers = {
      ...this.headers,
      ...headersParam,
    };

    if (this._authOpions) {
      // Phase B: generateAuthString is async (Deno crypto); Yellowstone's was sync.
      // This is the required Node→Deno mechanical swap for crypto.
      const authString = await generateAuthString(
        this._authOpions,
        this.username,
        this.password,
        requestName,
        url!,
      );
      Object.assign(headers, { Authorization: authString });
    }

    req += Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("");

    this.emit("log", req, "C->S");

    // Write text request — encode to Uint8Array (Node socket.write(string) → transport.write(Uint8Array))
    const encoded = new TextEncoder().encode(`${req}\r\n`);
    await this._transport.write(encoded);

    return new Promise((resolve, reject) => {
      const responseHandler = (
        responseName: unknown,
        resHeaders: unknown,
        mediaHeaders: unknown,
      ) => {
        const rName = responseName as string;
        const rHeaders = resHeaders as Headers;
        const mHeaders = mediaHeaders as string[];

        const firstAnswer: string = String(rHeaders[""]) || "";
        if (firstAnswer.indexOf("401") >= 0 && "Authorization" in headers) {
          reject(new Error("Bad RTSP credentials!"));
          return;
        }
        if (rHeaders.CSeq !== id) {
          return;
        }

        this.removeListener("response", responseHandler as (...args: unknown[]) => void);

        const statusCode = parseInt(rName.split(" ")[1]);

        if (statusCode === STATUS_OK) {
          if (mHeaders.length > 0) {
            resolve({ headers: rHeaders, mediaHeaders: mHeaders });
          } else {
            resolve({ headers: rHeaders });
          }
        } else {
          const authHeader = rHeaders[WWW_AUTH];

          if (statusCode === STATUS_UNAUTH && authHeader) {
            // Phase B: faithful to Yellowstone — parse WWW-Authenticate and retry
            // Use our auth.ts parseAuthChallenge (which mirrors Yellowstone's inline parsing)
            this._authOpions = parseAuthChallenge(authHeader as string);

            // Repeat the request — resolve with the retry promise
            resolve(this.request(requestName, headers, url));
            return;
          }

          reject(new Error(`Bad RTSP status code ${statusCode}!`));
          return;
        }
      };

      this.on("response", responseHandler as (...args: unknown[]) => void);
    });
  }

  // -------------------------------------------------------------------------
  // respond — port of Yellowstone's respond()
  // -------------------------------------------------------------------------

  respond(status: string, headersParam: Headers = {}): void {
    if (!this._transport) {
      return;
    }

    let res = `RTSP/1.0 ${status}\r\n`;

    const headers: Headers = {
      ...this.headers,
      ...headersParam,
    };

    res += Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("");

    this.emit("log", res, "C->S");
    const encoded = new TextEncoder().encode(`${res}\r\n`);
    this._transport.write(encoded).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // play / pause — port of Yellowstone's play() / pause()
  // -------------------------------------------------------------------------

  async play(): Promise<void> {
    if (!this.isConnected) throw new Error("Client is not connected.");
    await this.request("PLAY", { Session: this._session });
  }

  async pause(): Promise<void> {
    if (!this.isConnected) throw new Error("Client is not connected.");
    await this.request("PAUSE", { Session: this._session });
  }

  // -------------------------------------------------------------------------
  // close — port of Yellowstone's close()
  // -------------------------------------------------------------------------

  async close(isImmediate = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (!this._transport) return;

    if (!isImmediate) {
      await this.request("TEARDOWN", { Session: this._session });
    }

    this._transport.close();
    this.removeAllListeners("response");

    if (this._keepAliveID !== undefined) {
      clearInterval(this._keepAliveID);
      this._keepAliveID = undefined;
    }

    this.isConnected = false;
    this._cSeq = 0;
  }

  // -------------------------------------------------------------------------
  // _onData — port of Yellowstone's _onData(data: Buffer)
  //
  // Phase B: faithful to Yellowstone — ReadStates state machine.
  // Quirks preserved:
  //   - messageBytes is number[] throughout (not Uint8Array)
  //   - String.fromCharCode.apply(null, messageBytes) for header text decoding
  //     (Phase B: faithful to Yellowstone — corrected in Phase C with TextDecoder)
  //   - Unexpected-byte branch throws (Phase B: faithful; anchored resync in Phase C)
  // -------------------------------------------------------------------------

  _onData(data: Uint8Array): void {
    let index = 0;

    // $ (0x24)
    const PACKET_START = 0x24;
    // R (0x52)
    const RTSP_HEADER_START = 0x52;
    // \n (10)
    const ENDL = 10;

    while (index < data.length) {
      // read RTP or RTCP packet
      if (this.readState === ReadStates.SEARCHING && data[index] === PACKET_START) {
        this.messageBytes = [data[index]];
        index++;
        this.readState = ReadStates.READING_RAW_PACKET_SIZE;
      } else if (this.readState === ReadStates.READING_RAW_PACKET_SIZE) {
        this.messageBytes.push(data[index]);
        index++;

        if (this.messageBytes.length === 4) {
          this.rtspPacketLength = (this.messageBytes[2] << 8) + this.messageBytes[3];

          if (this.rtspPacketLength > 0) {
            // Phase B: faithful to Yellowstone — Buffer.alloc → new Uint8Array
            this.rtspPacket = new Uint8Array(this.rtspPacketLength);
            this.rtspPacketPointer = 0;
            this.readState = ReadStates.READING_RAW_PACKET;
          } else {
            this.readState = ReadStates.SEARCHING;
          }
        }
      } else if (this.readState === ReadStates.READING_RAW_PACKET) {
        this.rtspPacket[this.rtspPacketPointer++] = data[index];
        index++;

        if (this.rtspPacketPointer === this.rtspPacketLength) {
          const packetChannel = this.messageBytes[1];
          if ((packetChannel & 0x01) === 0) {
            // even number → RTP
            const packet = parseRTPPacket(this.rtspPacket);

            const detail = this.setupResult.find(
              (item) => item.rtpChannel === packetChannel,
            );
            if (detail !== undefined) packet.wallclockTime = this.GetWallClockTime(packet, detail);

            this.emit("data", packetChannel, packet.payload, packet);

            // Feed H264 depacketizer for the video channel
            if (detail?.isH264 && this._depacketizer) {
              this._depacketizer.processRTPPacket(packet);
            }
          }
          if ((packetChannel & 0x01) === 1) {
            // odd number → RTCP
            const packet = parseRTCPPacket(this.rtspPacket);

            if (packet.packetType === 200 && packet.senderReport !== undefined) {
              const detail = this.setupResult.find(
                (item) => item.rtcpChannel === packetChannel,
              );
              if (detail !== undefined) {
                detail.sr_ntpMSW = packet.senderReport.ntpTimestampMSW;
                detail.sr_ntpLSW = packet.senderReport.ntpTimestampLSW;
                detail.sr_rtptimestamp = packet.senderReport.rtpTimestamp;
              }
            }

            this.emit("controlData", packetChannel, packet);

            const receiver_report = emptyReceiverReport(this.clientSSRC);
            this._sendInterleavedData(packetChannel, receiver_report);
          }
          this.readState = ReadStates.SEARCHING;
        }

        // read response data
      } else if (
        this.readState === ReadStates.SEARCHING &&
        data[index] === RTSP_HEADER_START
      ) {
        this.messageBytes = [data[index]];
        index++;
        this.readState = ReadStates.READING_RTSP_HEADER;
      } else if (this.readState === ReadStates.READING_RTSP_HEADER) {
        // Ignore \r (13) but keep \n (10)
        if (data[index] !== 13) {
          this.messageBytes.push(data[index]);
        }
        index++;

        // Two consecutive \n → end of RTSP headers
        if (
          this.messageBytes.length >= 2 &&
          this.messageBytes[this.messageBytes.length - 2] === ENDL &&
          this.messageBytes[this.messageBytes.length - 1] === ENDL
        ) {
          // Phase B: faithful to Yellowstone — String.fromCharCode.apply for header text
          // (corrected in Phase C with TextDecoder)
          const text = String.fromCharCode.apply(null, this.messageBytes);
          const lines = text.split("\n");

          this.rtspContentLength = 0;
          this.rtspStatusLine = lines[0];
          this.rtspHeaders = {};

          lines.forEach((line) => {
            const indexOf = line.indexOf(":");

            if (indexOf !== line.length - 1) {
              const key = line.substring(0, indexOf).trim();
              const lineData = line.substring(indexOf + 1).trim();

              if (key === "Session") {
                this.rtspHeaders[key] = lineData;
              } else if (key === "WWW-Authenticate") {
                // Phase B: faithful to Yellowstone — prefer Digest over Basic
                if (key in this.rtspHeaders) {
                  console.log("Duplicate WWW-Authenticate keys");
                  if (
                    lineData.startsWith("Digest") &&
                    (this.rtspHeaders[key] as string)?.startsWith("Basic")
                  ) {
                    this.rtspHeaders[key] = lineData; // Replace Basic with Digest
                  }
                  console.log("Keeping WWW-Authenticate: " + this.rtspHeaders[key]);
                } else {
                  this.rtspHeaders[key] = lineData;
                }
              } else {
                // Store as String or Number type — faithful to Yellowstone
                this.rtspHeaders[key] = lineData.match(/^[0-9]+$/)
                  ? parseInt(lineData, 10)
                  : lineData;
              }

              // Phase B: faithful to Yellowstone — workaround for buggy cameras (Content-length vs Content-Length)
              if (key.toLowerCase() === "content-length") {
                this.rtspContentLength = parseInt(lineData, 10);
              }
            }
          });

          if (!this.rtspContentLength) {
            this.emit("log", text, "S->C");
            this.emit("response", this.rtspStatusLine, this.rtspHeaders, []);
            this.readState = ReadStates.SEARCHING;
          } else {
            this.messageBytes = [];
            this.readState = ReadStates.READING_RTSP_PAYLOAD;
          }
        }
      } else if (
        this.readState === ReadStates.READING_RTSP_PAYLOAD &&
        this.messageBytes.length < this.rtspContentLength
      ) {
        this.messageBytes.push(data[index]);
        index++;

        if (this.messageBytes.length === this.rtspContentLength) {
          // Phase B: faithful to Yellowstone — String.fromCharCode.apply for payload text
          // (corrected in Phase C with TextDecoder)
          const text = String.fromCharCode.apply(null, this.messageBytes);
          const mediaHeaders = text.split("\n");

          // Phase B: faithful to Yellowstone — log message duplicates body (emit body twice)
          this.emit(
            "log",
            String.fromCharCode.apply(null, this.messageBytes) + text,
            "S->C",
          );

          this.emit("response", this.rtspStatusLine, this.rtspHeaders, mediaHeaders);
          this.readState = ReadStates.SEARCHING;
        }
      } else {
        // Phase B: faithful to Yellowstone — unexpected data throws
        // (corrected in Phase C with anchored resync)
        throw new Error(
          "Bug in RTSP data framing, please file an issue with the author with stacktrace.",
        );
      }
    } // end while
  }

  // -------------------------------------------------------------------------
  // _sendInterleavedData — port of Yellowstone's _sendInterleavedData()
  // Phase B: faithful — Buffer.alloc(4) → new Uint8Array(4), Buffer.concat → manual concat
  // -------------------------------------------------------------------------

  _sendInterleavedData(channel: number, buffer: Uint8Array): void {
    if (!this._transport) return;

    const req = `${buffer.length} bytes of interleaved data on channel ${channel}`;
    this.emit("log", req, "C->S");

    // Phase B: faithful to Yellowstone — 4-byte $-frame header
    const header = new Uint8Array(4);
    header[0] = 0x24; // ascii $
    header[1] = channel;
    header[2] = (buffer.length >> 8) & 0xff;
    header[3] = (buffer.length >> 0) & 0xff;

    // Phase B: faithful to Yellowstone — Buffer.concat → manual Uint8Array concat
    const data = new Uint8Array(header.length + buffer.length);
    data.set(header, 0);
    data.set(buffer, header.length);

    this._transport.write(data).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // _emptyReceiverReport — port of Yellowstone's _emptyReceiverReport()
  // Delegated to rtcp.ts emptyReceiverReport(clientSSRC).
  // -------------------------------------------------------------------------

  _emptyReceiverReport(): Uint8Array {
    return emptyReceiverReport(this.clientSSRC);
  }

  // -------------------------------------------------------------------------
  // GetWallClockTime — port of Yellowstone's GetWallClockTime()
  // -------------------------------------------------------------------------

  GetWallClockTime(
    packet: { timestamp: number },
    detail: Detail,
  ): Date | undefined {
    if (
      detail.sr_ntpMSW !== undefined &&
      detail.sr_ntpLSW !== undefined &&
      detail.sr_rtptimestamp !== undefined &&
      detail.mediaSource.rtp[0].rate !== undefined
    ) {
      const rate = detail.mediaSource.rtp[0].rate!;
      const refTimestampSecs = detail.sr_rtptimestamp / rate;
      const packetTimestampSecs = packet.timestamp / rate;
      const packetTimestampDeltaSecs = packetTimestampSecs - refTimestampSecs;
      const refTimestamp = new Date(
        this.ntpBaseDate_ms +
          detail.sr_ntpMSW * 1000 +
          (detail.sr_ntpLSW / Math.pow(2, 32)) * 1000,
      );
      const wallclockTime = new Date(
        refTimestamp.getTime() + packetTimestampDeltaSecs * 1000,
      );
      return wallclockTime;
    }
    return undefined;
  }
}
