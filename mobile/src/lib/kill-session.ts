import type { ServerConfig } from "./storage";

// killSession asks the server to tear down the tmux session with the given id.
// The tmux session outliving the client is aura's core invariant, so the only
// way to actually stop one is this explicit DELETE.
export async function killSession(cfg: ServerConfig, id: string): Promise<void> {
  const base = cfg.url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
  const res = await fetch(`${base}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`kill session failed: ${res.status}`);
  }
}
