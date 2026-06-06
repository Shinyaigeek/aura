// Client for the server's /shares endpoints — the "files Claude shared back
// to me" gallery. Mirror image of upload.ts: where upload pushes a file from
// the phone to the host, this pulls the list of files the host has made
// available (anything dropped into AURA_SHARE_DIR) and builds authed URLs the
// WebView/Image can load directly.

import type { ServerConfig } from "./storage";

export type SharedItem = {
  name: string;
  size: number;
  /** Modification time, unix seconds. Server sorts newest-first already. */
  modUnix: number;
  /** Best-effort MIME from the file extension; "" when unknown. */
  mime: string;
  /** Server-relative path, e.g. "/shares/shot.png" (name is URL-escaped). */
  url: string;
};

// httpBase normalizes the configured server URL to an http(s) origin with no
// trailing slash, matching upload.ts so ws:// configs still resolve. Exported
// so the media viewer can use it as the WebView baseUrl (which makes the
// token-authed media URL same-origin — no mixed-content trouble).
export function httpBase(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

// listShares fetches the current contents of the share dir. Newest first.
export async function listShares(cfg: ServerConfig): Promise<SharedItem[]> {
  const res = await fetch(`${httpBase(cfg)}/shares`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    throw new Error(`list shares failed (${res.status})`);
  }
  const parsed = (await res.json()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("shares: unexpected response");
  return parsed as SharedItem[];
}

// shareItemUri builds an absolute, token-authed URL for a single item, safe to
// hand to a <WebView> or <Image source={{ uri }}>. Auth rides as the `token`
// query param because RN Image/WebView can't easily attach an Authorization
// header, and the server's auth middleware already accepts ?token=.
export function shareItemUri(cfg: ServerConfig, item: SharedItem): string {
  return `${httpBase(cfg)}${item.url}?token=${encodeURIComponent(cfg.token)}`;
}

// isImage / isVideo drive how the gallery renders a thumbnail and which player
// the viewer picks. Unknown types fall through to a generic file tile.
export function isImage(item: SharedItem): boolean {
  return item.mime.startsWith("image/");
}

export function isVideo(item: SharedItem): boolean {
  return item.mime.startsWith("video/");
}
