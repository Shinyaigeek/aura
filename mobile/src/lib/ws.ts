// Resilient WebSocket client for aura-server.
//
// Design goals:
//   - The tmux session on the server is the source of truth. This client
//     only carries bytes. Reconnect means "reattach to the same session",
//     which the server provides natively via `?session=<id>`.
//   - Exponential backoff with jitter, capped at 30s.
//   - Reconnect immediately when the app foregrounds after being
//     backgrounded — mobile OSes aggressively tear down sockets and the
//     user's expectation is that the terminal is "just there" when they
//     open the app.

import type { ServerConfig } from "./storage";

export type WsStatus = "connecting" | "open" | "closed";

export type WsClientCallbacks = {
  onStatus: (status: WsStatus) => void;
  onBinary: (data: ArrayBuffer) => void;
  onText?: (text: string) => void;
};

export type ControlMessage =
  | { type: "resize"; rows: number; cols: number }
  | { type: "ping" };

const MAX_BACKOFF_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly cb: WsClientCallbacks,
  ) {}

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.cb.onStatus("closed");
  }

  /** Force a reconnect immediately — used when the app returns to foreground. */
  kick(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.connect();
  }

  sendInput(data: ArrayBuffer | Uint8Array | string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (typeof data === "string") {
      this.ws.send(data);
      return;
    }
    // React Native's WebSocket accepts ArrayBuffer.
    const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
    this.ws.send(ab);
  }

  sendControl(msg: ControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    this.cb.onStatus("connecting");

    const url = this.buildUrl();
    // `bearer.<token>` subprotocol is also accepted by the server, used for
    // browser-based clients. On RN we use the query param; either works.
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.cb.onStatus("open");
    };

    ws.onmessage = (event: WebSocketMessageEvent) => {
      const data = event.data;
      if (typeof data === "string") {
        this.cb.onText?.(data);
      } else if (data instanceof ArrayBuffer) {
        this.cb.onBinary(data);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.cb.onStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; let it drive reconnect.
    };
  }

  private buildUrl(): string {
    const base = this.cfg.url.replace(/\/+$/, "");
    const params = new URLSearchParams({
      session: this.cfg.sessionId || "default",
      token: this.cfg.token,
    });
    return `${base}/ws?${params.toString()}`;
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const jitter = Math.random() * 250;
    const delay = baseDelay + jitter;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.connect();
    }, delay);
  }
}
