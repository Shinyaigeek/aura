// Fetches the full scrollback of a tmux-backed session from aura-server via
// GET /sessions/{id}/capture. The header copy button prefers this over the
// on-device xterm buffer dump: the dump can only reach what tmux is currently
// painting (the visible screen), whereas the server runs `tmux capture-pane
// -S -` and returns the pane's history too — so the user can copy output that
// has scrolled off the top.
//
// Best-effort: an unreachable server, a missing token, or a server too old to
// have the endpoint (404) all resolve to null, letting the caller fall back to
// the xterm dump.

import type { ServerConfig } from "./storage";

function httpBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

export async function fetchSessionCapture(
  cfg: ServerConfig,
  sessionId: string,
): Promise<string | null> {
  if (!cfg.url || !cfg.token || !sessionId) return null;
  try {
    const res = await fetch(
      `${httpBase(cfg.url)}/sessions/${encodeURIComponent(sessionId)}/capture`,
      { headers: { Authorization: `Bearer ${cfg.token}` } },
    );
    if (!res.ok) return null;
    // Drop the blank padding lines capture-pane leaves below the cursor at the
    // bottom of the pane — same trailing-empty trim the xterm dump does.
    return (await res.text()).replace(/\s+$/, "");
  } catch {
    return null;
  }
}
