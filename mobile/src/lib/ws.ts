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

export type ControlMessage = { type: "resize"; rows: number; cols: number } | { type: "ping" };

export type DirEntry = { name: string; isDir: boolean };

export type RequestMessage = { type: "cwd" } | { type: "listdir"; path: string };

export type CwdResponse = { type: "cwd_response"; id: string; path: string };
export type ListdirResponse = {
  type: "listdir_response";
  id: string;
  path: string;
  entries: DirEntry[];
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_BACKOFF_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private nextRequestId = 1;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly sessionId: string,
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
    this.rejectAllPending(new Error("stopped"));
    this.cb.onStatus("closed");
  }

  /** Force a (re)connect immediately — used when the app returns to foreground
   * or when a previously-stopped client is being revived (e.g. tab becomes
   * active again after an idle detach). Resets `closedByUser` so that the next
   * dropped connection triggers auto-reconnect instead of staying dead. */
  kick(): void {
    this.closedByUser = false;
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
    const ab =
      data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.ws.send(ab);
  }

  sendControl(msg: ControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a request and await its correlated response. Rejects on timeout,
   * transport close, or server-side error frame. */
  request<T>(msg: RequestMessage, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = `r${this.nextRequestId++}`;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ ...msg, id }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private dispatchText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.cb.onText?.(text);
      return;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "id" in parsed &&
      typeof (parsed as { id: unknown }).id === "string"
    ) {
      const msg = parsed as { id: string; type?: string; message?: string };
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "error") {
          p.reject(new Error(msg.message ?? "server error"));
        } else {
          p.resolve(parsed);
        }
        return;
      }
    }
    this.cb.onText?.(text);
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
        this.dispatchText(data);
      } else if (data instanceof ArrayBuffer) {
        this.cb.onBinary(data);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.rejectAllPending(new Error("connection closed"));
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
      session: this.sessionId || "default",
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
