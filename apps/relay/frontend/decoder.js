// WebCodecs frontend decoder (shared by webview and remote browser). Spec §5.
// Receives the `config` message, builds the avcC `description`, and decodes
// AVCC chunks to the <canvas id="video">.

const canvas = document.getElementById("video");
const ctx = canvas.getContext("2d");
let decoder = null;

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

const ws = new WebSocket(`ws://${location.host}/`);
ws.binaryType = "arraybuffer";

// Pick a decoder config the browser actually supports. Firefox rejects some
// hardwareAcceleration hints outright (throwing "encoding not supported" from
// configure), so we probe with isConfigSupported and fall back from a
// hardware-preferred config to a plain one before giving up.
async function negotiateConfig(base) {
  const candidates = [
    { ...base, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    { ...base, optimizeForLatency: true },
    { ...base },
  ];
  for (const config of candidates) {
    try {
      const { supported } = await VideoDecoder.isConfigSupported(config);
      if (supported) return config;
    } catch (e) {
      console.warn("isConfigSupported rejected a candidate:", e.message);
    }
  }
  return null;
}

ws.onmessage = async (ev) => {
  if (typeof ev.data === "string") {
    const cfg = JSON.parse(ev.data);
    if (cfg.type !== "config") return;

    const base = {
      codec: cfg.codec,
      description: buildAvcc(Uint8Array.from(cfg.sps), Uint8Array.from(cfg.pps)),
    };
    const config = await negotiateConfig(base);
    if (!config) {
      console.error(
        `No VideoDecoder config supported for codec ${cfg.codec}. ` +
          `This browser likely lacks H.264 WebCodecs support — try Chrome/Edge.`,
      );
      return;
    }

    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        frame.close(); // release the hardware buffer — mandatory
      },
      error: (e) => console.error("decode error:", e),
    });
    decoder.configure(config);
    return;
  }

  if (!decoder || decoder.state !== "configured") return;
  const buf = new Uint8Array(ev.data);
  const isKey = buf[0] === 1;
  const ts = Number(new DataView(buf.buffer).getBigUint64(1, false));
  const data = buf.subarray(9);

  if (decoder.decodeQueueSize > 5 && !isKey) return; // backpressure: shed deltas

  decoder.decode(
    new EncodedVideoChunk({
      type: isKey ? "key" : "delta",
      timestamp: ts,
      data,
    }),
  );
};
