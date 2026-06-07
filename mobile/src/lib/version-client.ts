// Fetches the running aura-server's version from its GET /version endpoint so
// the Settings screen can show which server the app is talking to alongside
// the mobile app's own version. Best-effort: an unreachable server, an older
// server without the endpoint, or any network blip resolves to null rather
// than throwing.

import type { ServerConfig } from "./storage";

// httpBase normalizes the configured ws(s):// URL to an http(s) origin with no
// trailing slash — same transform the other server clients use.
function httpBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

export async function fetchServerVersion(cfg: ServerConfig): Promise<string | null> {
  if (!cfg.url) return null;
  try {
    // /version is unauthenticated, but we send the token anyway to match the
    // other clients — the server ignores it on this route.
    const res = await fetch(`${httpBase(cfg.url)}/version`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : undefined,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}
