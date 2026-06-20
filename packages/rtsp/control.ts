// remotecontrold client — drives touch + button input on the B&G/Navico MFD.
//
// Faithful port of the control path in reference-client/navicoos_remote_client
// (core.py + cli.py). Speaks the device's TCP protocol on port 6633 over the
// same WireGuard tunnel the RTSP video uses, reusing TcpTransport.
//
// Wire format (all big-endian):
//   Every packet is [uint16 payload-length][payload]; the length excludes itself.
//   PING is the one exception that is hand-built with its length already inline.
//
// Handshake (must complete before sending events):
//   1. PING      -> 00 06 00 01 44 03 D7 C3   (len=6, opcode=0x0001, magic)
//   2. PING REPLY <- device info + dynamic keycode table + resolution
//   3. AUTH      -> opcode 0x0003 + 6-byte MAC + 32-byte client name
//   4. AUTH ACK  <- opcode 0x0004
//
// Events:
//   TOUCH  opcode 0x1001: timestamp(u32) x(u16) y(u16) event_type(u8) count(u8)
//          event_type 0=down 1=move 2=up; x/y absolute pixels in coded resolution.
//   KEY    opcode 0x1003: keycode(u32) pressRelease(u32). A button press sends
//          two packets: press (1) then release (0).

import { TcpTransport } from "./transport.ts";

const REMOTECONTROLD_PORT = 6633;

const OP_PING = 0x0001;
const OP_AUTH = 0x0003;
const OP_AUTH_ACK = 0x0004;
const OP_TOUCH = 0x1001;
const OP_KEY = 0x1003;

const PING_MAGIC = 0x4403d7c3;

/** Hand-built PING: length(6) opcode(1) magic — its length is already inline. */
const PING_PACKET = new Uint8Array([0x00, 0x06, 0x00, 0x01, 0x44, 0x03, 0xd7, 0xc3]);

/** Device button index -> stable function label (mirrors BUTTON_MAP in core.py). */
const BUTTON_MAP: Record<number, string> = {
  0x01: "Page",
  0x02: "Menu",
  0x03: "Zoom In",
  0x04: "Zoom Out",
  0x05: "Power",
  0x07: "Enter",
  0x08: "Cancel",
  0x09: "MOB",
  0x0a: "Goto",
  0x0b: "Mark",
  0x0c: "WheelKey",
};

export interface DeviceButton {
  /** Human-readable function label, e.g. "Menu". */
  label: string;
  /** Dynamic keycode discovered from the PING reply. */
  keycode: number;
}

export interface DeviceInfo {
  name: string;
  model: string;
  version: string;
  /** Coded display resolution reported by the device (falls back to 1280x720). */
  width: number;
  height: number;
}

export type TouchEvent = 0 | 1 | 2; // down | move | up

/**
 * Persistent control connection to one MFD. Construct, `connect()` (runs the
 * handshake and populates `buttons`/`info`), then send touch/key events.
 */
export class ControlClient {
  private _transport = new TcpTransport();
  private _connected = false;

  /** Reassembly buffer for the length-prefixed inbound stream. */
  private _rx = new Uint8Array(0);
  /** Queue of complete frame payloads (bytes after the 2-byte length prefix). */
  private _frames: Uint8Array[] = [];
  /** Pending reader waiting for the next frame. */
  private _waiter: ((frame: Uint8Array) => void) | null = null;
  private _waitReject: ((err: unknown) => void) | null = null;

  /** label -> keycode, populated by the PING reply. */
  readonly keycodes = new Map<string, number>();
  /** Ordered button list for the UI. */
  buttons: DeviceButton[] = [];
  info: DeviceInfo = { name: "", model: "", version: "", width: 1280, height: 720 };

  constructor(
    private readonly host: string,
    private readonly mac: string,
    private readonly clientName = "iPad",
    private readonly port = REMOTECONTROLD_PORT,
  ) {}

  /** Connect + run PING/AUTH handshake. Resolves once the device is ready for events. */
  async connect(): Promise<void> {
    await this._transport.connect(this.host, this.port);
    this._transport.listen(
      (chunk) => this._onData(chunk),
      () => this._fail(new Error("control connection closed")),
      (err) => this._fail(err),
    );
    this._connected = true;

    // 1. PING -> 2. PING REPLY
    await this._transport.write(PING_PACKET);
    const reply = await this._readFrame();
    this._parsePingReply(reply);

    // 3. AUTH -> 4. AUTH ACK
    await this._transport.write(this._buildAuthPacket());
    const ack = await this._readFrame();
    const opcode = (ack[0] << 8) | ack[1];
    if (opcode !== OP_AUTH_ACK) {
      throw new Error(`control: unexpected auth response opcode 0x${opcode.toString(16)}`);
    }
  }

  /** Send a touch event. x/y are absolute device pixels (caller clamps to coded res). */
  sendTouch(x: number, y: number, event: TouchEvent): Promise<void> {
    const payload = new Uint8Array(12);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, OP_TOUCH, false);
    dv.setUint32(2, this._timestamp(), false);
    dv.setUint16(6, x & 0xffff, false);
    dv.setUint16(8, y & 0xffff, false);
    dv.setUint8(10, event);
    dv.setUint8(11, 1); // touch_count
    return this._send(payload);
  }

  /** Send a single key event (press=1, release=0). */
  sendKey(keycode: number, press: 0 | 1): Promise<void> {
    const payload = new Uint8Array(10);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, OP_KEY, false);
    dv.setUint32(2, keycode >>> 0, false);
    dv.setUint32(6, press, false);
    return this._send(payload);
  }

  /** Press a button by its function label (sends press then release). */
  async pressButton(label: string): Promise<void> {
    const keycode = this.keycodes.get(label);
    if (keycode === undefined) throw new Error(`control: unknown button "${label}"`);
    await this.sendKey(keycode, 1);
    await this.sendKey(keycode, 0);
  }

  close(): void {
    this._connected = false;
    this._transport.close();
  }

  // --- internals ----------------------------------------------------------

  /** Length-prefix a payload and write it. */
  private _send(payload: Uint8Array): Promise<void> {
    const frame = new Uint8Array(2 + payload.length);
    new DataView(frame.buffer).setUint16(0, payload.length, false);
    frame.set(payload, 2);
    return this._transport.write(frame);
  }

  /** Monotonic millisecond timestamp, wrapped to uint32 (mirrors int(monotonic*1000)). */
  private _timestamp(): number {
    return Math.round(performance.now()) >>> 0;
  }

  private _buildAuthPacket(): Uint8Array {
    const mac = this.mac.replace(/:/g, "");
    if (mac.length !== 12) throw new Error("control: MAC must be 6 bytes (e.g. 00:11:22:33:44:55)");
    const payload = new Uint8Array(40);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, OP_AUTH, false);
    for (let i = 0; i < 6; i++) payload[2 + i] = parseInt(mac.slice(i * 2, i * 2 + 2), 16);
    // client name: null-padded ASCII into the 32-byte field at offset 8.
    const name = this.clientName.slice(0, 32);
    for (let i = 0; i < name.length; i++) payload[8 + i] = name.charCodeAt(i) & 0x7f;
    return this._frame(payload);
  }

  /** Length-prefix without writing (for packets we build whole). */
  private _frame(payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + payload.length);
    new DataView(out.buffer).setUint16(0, payload.length, false);
    out.set(payload, 2);
    return out;
  }

  /**
   * Parse the PING reply. `frame` is the payload AFTER the 2-byte length prefix,
   * so it begins with the 2-byte opcode. core.py's `payload` (which skipped
   * len+opcode = 4 bytes) therefore lives at frame offset 2 onward.
   */
  private _parsePingReply(frame: Uint8Array): void {
    const p = 2; // skip opcode; frame[p..] == core.py's `payload`
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const name = decodeAscii(frame, p + 4, 32);
    const model = decodeAscii(frame, p + 36, 32);
    const version = decodeAscii(frame, p + 68, 24);

    const count = frame[p + 92];
    for (let i = 0; i < count; i++) {
      const off = p + 93 + i * 8;
      const btnIndex = dv.getUint32(off, false);
      const keycode = dv.getUint32(off + 4, false);
      const label = BUTTON_MAP[btnIndex];
      if (label) {
        this.keycodes.set(label, keycode);
        this.buttons.push({ label, keycode });
      }
    }

    let width = 1280;
    let height = 720;
    const resOff = p + 93 + count * 8;
    if (frame.length >= resOff + 4) {
      width = dv.getUint16(resOff, false);
      height = dv.getUint16(resOff + 2, false);
    }
    this.info = { name, model, version, width, height };
  }

  // --- framed read pump ---------------------------------------------------

  private _onData(chunk: Uint8Array): void {
    // Append to the reassembly buffer.
    const merged = new Uint8Array(this._rx.length + chunk.length);
    merged.set(this._rx, 0);
    merged.set(chunk, this._rx.length);
    this._rx = merged;

    // Extract every complete [uint16 len][payload] frame.
    while (this._rx.length >= 2) {
      const len = (this._rx[0] << 8) | this._rx[1];
      if (this._rx.length < 2 + len) break; // partial frame; wait for more
      const payload = this._rx.slice(2, 2 + len);
      this._rx = this._rx.slice(2 + len);
      this._deliver(payload);
    }
  }

  private _deliver(frame: Uint8Array): void {
    if (this._waiter) {
      const resolve = this._waiter;
      this._waiter = null;
      this._waitReject = null;
      resolve(frame);
    } else {
      this._frames.push(frame);
    }
  }

  /** Await the next complete frame payload (opcode-prefixed). */
  private _readFrame(): Promise<Uint8Array> {
    const queued = this._frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this._waiter = resolve;
      this._waitReject = reject;
    });
  }

  private _fail(err: unknown): void {
    if (this._waitReject) {
      const reject = this._waitReject;
      this._waiter = null;
      this._waitReject = null;
      reject(err);
    }
  }
}

function decodeAscii(buf: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = Math.min(offset + maxLen, buf.length);
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder("ascii").decode(buf.subarray(offset, end));
}
