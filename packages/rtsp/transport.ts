/// <reference lib="deno.unstable" />
// Phase-B faithful port: abstracts the socket operations that RTSPClient
// performs inline against Node's net.Socket / tls.TLSSocket / dgram.Socket.
//
// Substitution table (per §1 of plans/yellowstone-incorporation.md):
//   net.connect      → Deno.connect       (TcpTransport)
//   tls.connect      → Deno.connectTls    (TlsTransport)
//   dgram            → Deno.listenDatagram (UdpReceiver) [requires --unstable-net]
//
// RTSPClient uses its TCP/TLS socket for three things:
//   1. write text (RTSP requests) and binary (interleaved RTP frames)
//   2. receive a continuous byte stream (drives the _onData state machine)
//   3. detect close / error
//
// It uses UDP sockets only for receiving RTP/RTCP datagrams (each socket is
// bound to a local port; the client also sends a single empty "hole punch"
// packet per socket before playback).
//
// This file defines a minimal interface for each role and provides concrete
// Deno-backed implementations. RTSPClient (built in wave B2) will accept these
// via constructor injection rather than constructing Node sockets inline.

// ---------------------------------------------------------------------------
// Shared callback types
// ---------------------------------------------------------------------------

/** Called when data arrives on the socket. */
export type DataCallback = (chunk: Uint8Array) => void;

/** Called when the socket closes (either end). */
export type CloseCallback = () => void;

/** Called when the socket encounters an error. */
export type ErrorCallback = (err: unknown) => void;

// ---------------------------------------------------------------------------
// StreamTransport — TCP / TLS (full-duplex, stream-oriented)
// ---------------------------------------------------------------------------

/** Minimal contract for a connected TCP or TLS stream socket. */
export interface StreamTransport {
  /** Write bytes to the remote. Returns when the write is flushed. */
  write(bytes: Uint8Array): Promise<void>;

  /**
   * Register callbacks for incoming data, close, and error events.
   * Starts the read-pump if not already running.
   * Phase-B note: mirrors RTSPClient's pattern of calling socket.on() after
   * connect, before the first request is sent.
   */
  listen(onData: DataCallback, onClose: CloseCallback, onError: ErrorCallback): void;

  /** Gracefully close the connection (sends FIN). */
  close(): void;
}

// ---------------------------------------------------------------------------
// TcpTransport
// ---------------------------------------------------------------------------

export class TcpTransport implements StreamTransport {
  private _conn: Deno.TcpConn | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _closed = false;

  /** Connect to host:port. Resolves when the TCP handshake completes. */
  async connect(hostname: string, port: number): Promise<void> {
    this._conn = await Deno.connect({ hostname, port, transport: "tcp" });
    this._writer = this._conn.writable.getWriter();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this._writer) throw new Error("TcpTransport: not connected");
    // Phase-B: bytes are already Uint8Array (Buffer → Uint8Array per §1 rulebook)
    await this._writer.write(bytes);
  }

  listen(onData: DataCallback, onClose: CloseCallback, onError: ErrorCallback): void {
    if (!this._conn) throw new Error("TcpTransport: not connected");
    // Run the read-pump in the background; callers do not await it.
    this._pump(this._conn, onData, onClose, onError);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._writer?.releaseLock();
      this._conn?.close();
    } catch {
      // Ignore double-close errors — faithful to Node socket.end() behaviour.
    }
  }

  private async _pump(
    conn: Deno.TcpConn,
    onData: DataCallback,
    onClose: CloseCallback,
    onError: ErrorCallback,
  ): Promise<void> {
    // Reuse a fixed-size read buffer; .subarray() produces a view (no copy),
    // matching Node Buffer.slice semantics (per §1 rulebook).
    const reader = conn.readable.getReader({ mode: "byob" });
    const buf = new ArrayBuffer(65536);
    try {
      while (!this._closed) {
        const { value, done } = await reader.read(new Uint8Array(buf));
        if (done || value === undefined) break; // EOF — remote closed
        onData(value.subarray(0, value.byteLength));
      }
    } catch (err) {
      if (!this._closed) {
        onError(err);
      }
    } finally {
      reader.releaseLock();
      if (!this._closed) {
        onClose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TlsTransport
// ---------------------------------------------------------------------------

export class TlsTransport implements StreamTransport {
  private _conn: Deno.TlsConn | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _closed = false;

  /**
   * Connect to host:port with TLS.
   * Phase-B note: Yellowstone passes `rejectUnauthorized: false` for rtsps://;
   * we faithfully mirror that with caCerts omitted and no cert verification.
   */
  async connect(hostname: string, port: number): Promise<void> {
    this._conn = await Deno.connectTls({
      hostname,
      port,
      // Phase-B faithful: Yellowstone sets rejectUnauthorized:false.
      // Deno equivalent: pass an empty caCerts array so the TLS stack
      // skips certificate chain validation (self-signed cams work).
      caCerts: [],
    });
    this._writer = this._conn.writable.getWriter();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this._writer) throw new Error("TlsTransport: not connected");
    await this._writer.write(bytes);
  }

  listen(onData: DataCallback, onClose: CloseCallback, onError: ErrorCallback): void {
    if (!this._conn) throw new Error("TlsTransport: not connected");
    this._pump(this._conn, onData, onClose, onError);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._writer?.releaseLock();
      this._conn?.close();
    } catch {
      // Ignore.
    }
  }

  private async _pump(
    conn: Deno.TlsConn,
    onData: DataCallback,
    onClose: CloseCallback,
    onError: ErrorCallback,
  ): Promise<void> {
    const reader = conn.readable.getReader({ mode: "byob" });
    const buf = new ArrayBuffer(65536);
    try {
      while (!this._closed) {
        const { value, done } = await reader.read(new Uint8Array(buf));
        if (done || value === undefined) break;
        onData(value.subarray(0, value.byteLength));
      }
    } catch (err) {
      if (!this._closed) {
        onError(err);
      }
    } finally {
      reader.releaseLock();
      if (!this._closed) {
        onClose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// UdpReceiver — one-way receive + one-shot send (for hole-punch)
// ---------------------------------------------------------------------------

/** Callback invoked for each arriving UDP datagram. */
export type DatagramCallback = (
  data: Uint8Array,
  remoteAddr: Deno.NetAddr,
) => void;

/**
 * Wraps a single Deno.DatagramConn bound to a local UDP port.
 * Mirrors Yellowstone's dgram.Socket: bind to a port, receive messages,
 * and optionally send a single packet (NAT hole-punch).
 * Requires --unstable-net at runtime.
 */
export class UdpReceiver {
  private _socket: Deno.DatagramConn | null = null;
  private _closed = false;
  private _port: number;

  constructor(port: number) {
    this._port = port;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Bind the UDP socket to `this._port` on all interfaces.
   * Phase-B note: Yellowstone awaits a Promise wrapping dgram.bind callback.
   * Deno.listenDatagram is synchronous — no async needed.
   */
  bind(): void {
    this._socket = Deno.listenDatagram({
      port: this._port,
      transport: "udp",
      hostname: "0.0.0.0",
    });
  }

  /**
   * Start pumping received datagrams into `onMessage`.
   * Non-blocking — the pump runs as an unawaited async task.
   */
  listen(onMessage: DatagramCallback): void {
    if (!this._socket) throw new Error("UdpReceiver: not bound");
    this._pump(this._socket, onMessage);
  }

  /**
   * Send a single datagram to host:port (used for NAT hole-punch).
   * Phase-B faithful: Yellowstone calls rtpReceiver.send(Buffer.from(""), ...)
   * immediately after bind; the payload is typically zero bytes.
   */
  async send(data: Uint8Array, host: string, port: number): Promise<void> {
    if (!this._socket) throw new Error("UdpReceiver: not bound");
    await this._socket.send(data, { transport: "udp", hostname: host, port });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._socket?.close();
    } catch {
      // Ignore.
    }
  }

  private async _pump(
    socket: Deno.DatagramConn,
    onMessage: DatagramCallback,
  ): Promise<void> {
    try {
      for await (const [data, addr] of socket) {
        if (this._closed) break;
        onMessage(data, addr as Deno.NetAddr);
      }
    } catch {
      // Socket closed — normal shutdown path.
    }
  }
}

// ---------------------------------------------------------------------------
// One-shot UDP send helper (mirrors Yellowstone's _sendUDPData which creates
// a fresh dgram socket, sends, then closes it immediately).
// ---------------------------------------------------------------------------

/**
 * Send a single UDP datagram and discard the socket.
 * Phase-B faithful port of RTSPClient._sendUDPData.
 * Requires --unstable-net at runtime.
 */
export async function sendUdpOnce(
  host: string,
  port: number,
  data: Uint8Array,
): Promise<void> {
  // Bind to port 0 to let the OS assign an ephemeral source port.
  const sock = Deno.listenDatagram({
    port: 0,
    transport: "udp",
    hostname: "0.0.0.0",
  });
  try {
    await sock.send(data, { transport: "udp", hostname: host, port });
  } finally {
    sock.close();
  }
}
