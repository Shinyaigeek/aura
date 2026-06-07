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
import * as Speech from "expo-speech";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { loadPrefs, type Prefs, type ServerConfig, subscribePrefs } from "./storage";

export type ServerEvent = {
  type: "stop" | "notification";
  sessionId?: string;
  title?: string;
  body?: string;
  /** Assistant's closing message (Stop events), for read-aloud. */
  summary?: string;
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

  // Prefs drive read-aloud. Held in a ref so the long-lived onEvent closure
  // always sees the latest values without re-subscribing the socket.
  const prefsRef = useRef<Prefs | null>(null);
  useEffect(() => {
    void loadPrefs().then((p) => {
      prefsRef.current = p;
    });
    return subscribePrefs((p) => {
      prefsRef.current = p;
    });
  }, []);

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

      // Read Claude's closing message aloud when enabled. Only when the app
      // is foregrounded — speaking into a pocket is noise, and the
      // notification already covers the backgrounded case.
      const prefs = prefsRef.current;
      if (
        prefs?.speakReplies &&
        e.type === "stop" &&
        e.summary &&
        AppState.currentState === "active"
      ) {
        const spoken = cleanForSpeech(e.summary);
        if (spoken) {
          Speech.stop();
          Speech.speak(spoken, { language: prefs.voiceLang || undefined });
        }
      }
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

// SPEAK_CAP bounds how much of a reply we read aloud. Claude's closing
// message can be long; past a couple of paragraphs speech becomes a chore to
// sit through, so we cap and let the on-screen text carry the rest.
const SPEAK_CAP = 600;

// cleanForSpeech turns a markdown assistant message into something worth
// hearing: code blocks and inline code are dropped (reading symbols aloud is
// useless), markdown decoration is stripped, links collapse to their text,
// and whitespace is normalized. Returns "" when nothing speakable remains.
export function cleanForSpeech(md: string): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, " "); // fenced code blocks
  s = s.replace(/`[^`]*`/g, " "); // inline code
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
  s = s.replace(/[*_~]+/g, ""); // emphasis markers
  s = s.replace(/\s+/g, " ").trim(); // collapse whitespace
  if (s.length > SPEAK_CAP) {
    s = `${s.slice(0, SPEAK_CAP).trimEnd()}…`;
  }
  return s;
}
