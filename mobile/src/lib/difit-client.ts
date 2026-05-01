import type { ServerConfig } from "./storage";

// startDifit asks the server to spawn (or reuse) a difit instance for the
// given session and returns the port it bound to. The server picks a free
// port; we derive the full URL on the client because only the client knows
// what hostname the user is reaching the server through.
export async function startDifit(cfg: ServerConfig, sessionId: string): Promise<number> {
  const base = httpBase(cfg);
  const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/difit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`start difit failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { port?: number };
  if (typeof data.port !== "number") {
    throw new Error("server returned no port");
  }
  return data.port;
}

export async function stopDifit(cfg: ServerConfig, sessionId: string): Promise<void> {
  const base = httpBase(cfg);
  const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/difit`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`stop difit failed: ${res.status}`);
  }
}

// difitUrl derives the URL to load in a WebView from the server config and
// the port the server reported. We always force http:// — difit serves plain
// HTTP and the user reaches it directly over their tunnel, not through the
// (possibly-https) aura-server endpoint.
export function difitUrl(cfg: ServerConfig, port: number): string {
  const host = extractHost(cfg.url);
  return `http://${host}:${port}/`;
}

function httpBase(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

function extractHost(url: string): string {
  const cleaned = url.replace(/^ws(s?):\/\//, "http$1://");
  try {
    return new URL(cleaned).hostname;
  } catch {
    // Last-ditch: strip scheme + path manually.
    const m = cleaned.match(/^(?:https?:\/\/)?([^/:]+)/);
    return m ? m[1] : cleaned;
  }
}
