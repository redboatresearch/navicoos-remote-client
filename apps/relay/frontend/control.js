// Browser -> relay input: maps canvas pointer events to MFD touch coords and
// renders the device's hardware buttons. Driven by the `control` message the
// relay sends after the remotecontrold handshake (carries the button table and
// the coded resolution to map into).
//
// Wire format to the relay (JSON over the same WebSocket as video):
//   {t:"touch", x, y, e}   e: 0=down 1=move 2=up   x/y in device pixels
//   {t:"key", label}       label is a device button's function name

const MOVE_INTERVAL_MS = 16; // throttle pointermove (~60Hz); down/up always sent.

/**
 * Wire up touch + button control. Call once per `control` message.
 * @param canvas the video <canvas>
 * @param ws the open WebSocket to the relay
 * @param cfg {buttons:[{label,keycode}], width, height}
 */
export function setupControls(canvas, ws, cfg) {
  const W = cfg.width || 1280;
  const H = cfg.height || 720;
  const send = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // --- coordinate mapping: pointer -> coded device pixels ------------------
  // Normalize within the canvas's rendered rect, scale to the device's coded
  // resolution, round, and clamp to the last addressable pixel.
  const toDevice = (ev) => {
    const r = canvas.getBoundingClientRect();
    const nx = r.width ? (ev.clientX - r.left) / r.width : 0;
    const ny = r.height ? (ev.clientY - r.top) / r.height : 0;
    const x = Math.max(0, Math.min(W - 1, Math.round(nx * W)));
    const y = Math.max(0, Math.min(H - 1, Math.round(ny * H)));
    return { x, y };
  };

  // --- pointer events ------------------------------------------------------
  let down = false;
  let lastMove = 0;

  canvas.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    down = true;
    canvas.setPointerCapture(ev.pointerId);
    const { x, y } = toDevice(ev);
    send({ t: "touch", x, y, e: 0 });
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (!down) return;
    const now = ev.timeStamp;
    if (now - lastMove < MOVE_INTERVAL_MS) return; // throttle
    lastMove = now;
    const { x, y } = toDevice(ev);
    send({ t: "touch", x, y, e: 1 });
  });

  const endTouch = (ev) => {
    if (!down) return;
    down = false;
    const { x, y } = toDevice(ev);
    send({ t: "touch", x, y, e: 2 });
  };
  canvas.addEventListener("pointerup", endTouch);
  canvas.addEventListener("pointercancel", endTouch);
  // Disable the browser's touch gestures (scroll/zoom) over the canvas.
  canvas.style.touchAction = "none";

  // --- hardware button row -------------------------------------------------
  const bar = document.getElementById("buttons");
  if (!bar) return;
  bar.replaceChildren();
  for (const btn of cfg.buttons || []) {
    const el = document.createElement("button");
    el.className = "mfd-btn";
    el.textContent = btn.label;
    el.addEventListener("click", () => send({ t: "key", label: btn.label }));
    bar.appendChild(el);
  }
}
