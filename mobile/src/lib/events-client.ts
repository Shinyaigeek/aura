// Long-lived subscription to aura-server's /events WebSocket.
//
// The server fans Stop and Notification hook payloads to every
// connected /events client. We translate each event into a local
// notification via expo-notifications. There is no buffering on the
// server: events broadcast while we're disconnected are gone, so the
// reconnect strategy matters only for catching future events, not for
// replaying past ones.
//
// Reconnect: exponential backoff with jitter, capped at 30s. Foreground
// returns trigger an immediate kick — mobile OSes drop sockets when the
// app is backgrounded, and the user expects "open aura, see what
// happened while I was away" to Just Work.

import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { ServerConfig } from "./storage";

export type ServerEvent = {
  type: "stop" | "notification";
  sessionId?: string;
  title?: string;
  body?: string;
};

const MAX_BACKOFF_MS = 30_000;

export class EventsClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly onEvent: (e: ServerEvent) => void,
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
        // ignore — we're tearing down
      }
      this.ws = null;
    }
  }

  /** Force a (re)connect immediately. Idempotent against an already-OPEN
   * or CONNECTING socket so back-to-back kicks (e.g. AppState change +
   * focus event) don't leave duplicate sockets. */
  kick(): void {
    this.closedByUser = false;
    if (this.ws) {
      const rs = this.ws.readyState;
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    const url = this.buildUrl();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
    };

    ws.onmessage = (event: WebSocketMessageEvent) => {
      const raw = event.data;
      if (typeof raw !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isServerEvent(parsed)) return;
      this.onEvent(parsed);
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire and drive reconnect.
    };
  }

  private buildUrl(): string {
    const base = this.cfg.url.replace(/\/+$/, "");
    const params = new URLSearchParams({ token: this.cfg.token });
    return `${base}/events?${params.toString()}`;
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const jitter = Math.random() * 250;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.connect();
    }, baseDelay + jitter);
  }
}

function isServerEvent(v: unknown): v is ServerEvent {
  if (!v || typeof v !== "object") return false;
  const t = (v as { type?: unknown }).type;
  return t === "stop" || t === "notification";
}

// useEventsClient owns the /events subscription for the duration of cfg's
// life. Each event is scheduled as an immediate local notification.
// AppState transitions to "active" kick a reconnect because mobile OSes
// drop idle sockets when backgrounded.
export function useEventsClient(cfg: ServerConfig | null) {
  const url = cfg?.url ?? "";
  const token = cfg?.token ?? "";

  useEffect(() => {
    if (!url || !token) return;

    const client = new EventsClient({ url, token }, (e) => {
      void Notifications.scheduleNotificationAsync({
        content: {
          title: e.title ?? "Claude Code",
          body: e.body ?? "Session event",
          data: e.sessionId ? { sessionId: e.sessionId } : {},
          sound: "default",
        },
        trigger: null,
      });
    });
    client.start();

    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") client.kick();
    });

    return () => {
      sub.remove();
      client.stop();
    };
  }, [url, token]);
}
