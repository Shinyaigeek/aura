// Fetches per-session metadata (title, cwd) from the aura-server, which
// derives it from the Claude Code transcript associated with the tmux
// pane's cwd. Best-effort: a server that doesn't implement the endpoint,
// a network blip, or a pane without a CC transcript all resolve to an
// empty Meta rather than throwing.

import { useEffect, useState } from "react";

import type { ServerConfig } from "./storage";

export type SessionMeta = {
  title?: string;
  cwd?: string;
  transcriptAt?: string;
};

function httpBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

export async function fetchSessionMeta(
  cfg: ServerConfig,
  sessionId: string,
): Promise<SessionMeta | null> {
  if (!cfg.url || !cfg.token || !sessionId) return null;
  try {
    const res = await fetch(`${httpBase(cfg.url)}/sessions/${encodeURIComponent(sessionId)}/meta`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SessionMeta;
    return body ?? null;
  } catch {
    return null;
  }
}

// useSessionMeta fetches once and then every `refreshMs` milliseconds, so
// the tab title stays roughly in sync with whatever CC is doing in the
// pane. 30s is aggressive enough to pick up a /clear or a fresh session
// without burning battery.
export function useSessionMeta(
  cfg: ServerConfig | null,
  sessionId: string,
  refreshMs = 30_000,
): SessionMeta | null {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const url = cfg?.url ?? "";
  const token = cfg?.token ?? "";

  useEffect(() => {
    if (!url || !token || !sessionId) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const m = await fetchSessionMeta({ url, token }, sessionId);
      if (!cancelled) setMeta(m);
    };
    void run();
    const iv = setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [url, token, sessionId, refreshMs]);

  return meta;
}

// useSessionMetaMap polls /sessions/<id>/meta for every id in `sessionIds`
// and returns a stable map. Ids that drop out of the set are pruned on the
// next poll. Poll fan-out is parallel — a handful of tiny GETs every 30s
// is cheap even on mobile networks.
export function useSessionMetaMap(
  cfg: ServerConfig | null,
  sessionIds: readonly string[],
  refreshMs = 30_000,
): Record<string, SessionMeta> {
  const [map, setMap] = useState<Record<string, SessionMeta>>({});
  const url = cfg?.url ?? "";
  const token = cfg?.token ?? "";
  // Stable key so reorderings/renames don't re-trigger the effect.
  const idsKey = sessionIds.slice().sort().join("|");

  useEffect(() => {
    if (!url || !token || sessionIds.length === 0) {
      setMap({});
      return;
    }
    let cancelled = false;
    const ids = sessionIds.slice();
    const run = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => [id, await fetchSessionMeta({ url, token }, id)] as const),
      );
      if (cancelled) return;
      setMap((prev) => {
        const next: Record<string, SessionMeta> = {};
        for (const [id, m] of entries) {
          // Keep the previous value if this poll failed — better stale
          // than blank, since blank would blink the tab label back to id.
          next[id] = m ?? prev[id] ?? {};
        }
        return next;
      });
    };
    void run();
    const iv = setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token, idsKey, refreshMs]);

  return map;
}
