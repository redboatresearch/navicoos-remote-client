// WebCodecs frontend decoder (shared by webview and remote browser). Spec §5.
// Receives the `config` message, builds the avcC `description`, and decodes
// AVCC chunks to the <canvas id="video">.

import { setupControls } from "./control.js";

const canvas = document.getElementById("video");
const ctx = canvas.getContext("2d");

let decoder = null;
let description = null; // avcC bytes — parameter sets carried out-of-band
let codecString = null;
let forcedSoftware = false; // set once we downgrade after a hardware decode error
let waitingForKey = true; // after each (re)configure, drop deltas until a keyframe

// --- diagnostics ---------------------------------------------------------
let chosenHint = null; // hardwareAcceleration hint that isConfigSupported accepted
let decodeCalls = 0; // chunks handed to decoder.decode()
let framesOut = 0; // frames the decoder actually produced
let last = null; // last chunk we tried: { isKey, size, ts }
const log = (...a) => console.log("[decoder]", ...a);

function buildAvcc(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 0x01; // configurationVersion
  out[1] = sps[1]; // AVCProfileIndication
  out[2] = sps[2]; // profile_compatibility
  out[3] = sps[3]; // AVCLevelIndication
  out[4] = 0xff; // 6 bits reserved + lengthSizeMinusOne = 3 (4-byte lengths)
  out[5] = 0xe1; // 3 bits reserved + numOfSequenceParameterSets = 1
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  const p = 8 + sps.length;
  out[p] = 0x01; // numOfPictureParameterSets = 1
  out[p + 1] = (pps.length >> 8) & 0xff;
  out[p + 2] = pps.length & 0xff;
  out.set(pps, p + 3);
  return out;
}

const onFrame = (frame) => {
  framesOut++;
  if (framesOut === 1) {
    log(`first frame decoded: ${frame.displayWidth}x${frame.displayHeight} (hint=${chosenHint})`);
  }
  if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
  if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
  ctx.drawImage(frame, 0, 0);
  frame.close(); // release the hardware buffer — mandatory
};

// A VideoDecoder error closes the decoder permanently. Chrome's hardware path
// (VideoToolbox) can pass isConfigSupported and then fail HERE at decode time
// on a stream that software decoders handle fine. So on the first error,
// rebuild the decoder forcing software and resync from the next keyframe.
const onError = (e) => {
  console.error("[decoder] DECODE ERROR", {
    name: e.name,
    message: e.message,
    state: decoder && decoder.state,
    hint: chosenHint,
    forcedSoftware,
    decodeCalls,
    framesOut,
    lastChunk: last,
    codec: codecString,
  });
  if (!forcedSoftware) {
    forcedSoftware = true;
    console.warn("[decoder] hardware decode failed — rebuilding in software, resync on next keyframe");
    startDecoder();
  } else {
    console.error("[decoder] software decode ALSO failed — no further fallback");
  }
};

// Pick a config the browser actually supports. Firefox rejects some
// hardwareAcceleration hints outright (throwing from isConfigSupported), so we
// probe and fall back from the preferred accel hint to a plain config.
async function pickConfig() {
  const base = { codec: codecString, description };
  const hint = forcedSoftware ? "prefer-software" : "prefer-hardware";
  const candidates = [
    { ...base, hardwareAcceleration: hint, optimizeForLatency: true },
    { ...base, optimizeForLatency: true },
    { ...base },
  ];
  for (const config of candidates) {
    try {
      const { supported } = await VideoDecoder.isConfigSupported(config);
      log(`isConfigSupported(hint=${config.hardwareAcceleration ?? "none"}) -> ${supported}`);
      if (supported) {
        chosenHint = config.hardwareAcceleration ?? "none";
        return config;
      }
    } catch (e) {
      console.warn("[decoder] isConfigSupported rejected a candidate:", e.message);
    }
  }
  return null;
}

async function startDecoder() {
  const config = await pickConfig();
  if (!config) {
    console.error(
      `No VideoDecoder config supported for codec ${codecString}. ` +
        `This browser may lack H.264 WebCodecs support — try Chrome, Edge, or Firefox.`,
    );
    return;
  }
  decoder = new VideoDecoder({ output: onFrame, error: onError });
  decoder.configure(config);
  waitingForKey = true; // the first chunk after (re)configure must be a keyframe
  log(`configured: codec=${codecString} hint=${chosenHint} state=${decoder.state}`);
}

const ws = new WebSocket(`ws://${location.host}/`);
ws.binaryType = "arraybuffer";

ws.onmessage = (ev) => {
  if (typeof ev.data === "string") {
    const cfg = JSON.parse(ev.data);
    if (cfg.type === "config") {
      codecString = cfg.codec;
      description = buildAvcc(Uint8Array.from(cfg.sps), Uint8Array.from(cfg.pps));
      forcedSoftware = false;
      startDecoder();
    } else if (cfg.type === "control") {
      setupControls(canvas, ws, cfg);
    }
    return;
  }

  if (!decoder || decoder.state !== "configured") return;
  const buf = new Uint8Array(ev.data);
  const isKey = buf[0] === 1;
  const ts = Number(new DataView(buf.buffer).getBigUint64(1, false));
  const data = buf.subarray(9);

  // A freshly (re)configured decoder must start at a keyframe.
  if (waitingForKey) {
    if (!isKey) return;
    waitingForKey = false;
    log(`resync: first chunk after configure is key, size=${data.length} ts=${ts}`);
  }
  if (decoder.decodeQueueSize > 5 && !isKey) return; // backpressure: shed deltas

  last = { isKey, size: data.length, ts };
  decodeCalls++;
  try {
    decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: ts, data }));
  } catch (e) {
    // decode() throws synchronously if the decoder just closed on error;
    // onError handles the rebuild, so just swallow it here.
    console.warn("decode() threw:", e.message);
  }
};
