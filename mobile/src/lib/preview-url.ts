// Stream-friendly detector for local dev-server URLs printed by tools like
// Vite, Next.js, `python -m http.server`, etc. Operates on chunks of decoded
// terminal output and keeps a small carry buffer so a URL that straddles two
// frames is still picked up.
//
// We only match the loopback / wildcard hosts a dev server actually prints —
// remote URLs in build logs or commit messages should not trigger a preview
// banner.

import type { ServerConfig } from "./storage";

// ESC (0x1b) and BEL (0x07). Building the regexes from these constants keeps
// oxlint's no-control-regex rule happy while still letting us match ANSI
// sequences in the actual terminal stream.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const LOCAL_HOST_GROUP = "(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\[::1\\])";
const URL_RE = new RegExp(
  `https?:\\/\\/${LOCAL_HOST_GROUP}:(\\d{2,5})(\\/[^\\s${ESC}${BEL}"'<>()]*)?`,
  "gi",
);

// Strip ANSI CSI/OSC escape sequences. Vite and friends colorize URLs with
// ESC `[…m`; without stripping, the URL we surface to the user would carry
// stray escape bytes.
const ANSI_RE = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\\\-_])`,
  "g",
);

export type DetectedUrl = {
  // Cleaned URL exactly as it appeared in stdout (after substituting the
  // remote host for the local one and stripping ANSI). Suitable for handing
  // to a WebView.
  url: string;
  port: number;
};

export class PreviewUrlDetector {
  // Carry up to ~200 bytes of unmatched tail so a URL split across two
  // onBinary frames still gets recognized on the next chunk. Larger than a
  // realistic dev-server URL, smaller than anything that meaningfully grows
  // memory under load.
  private static readonly TAIL_BYTES = 200;
  private tail = "";
  // De-dupe: same URL reported repeatedly (tmux scrollback, dev-server
  // re-prints on file change) shouldn't spam the UI.
  private seen = new Set<string>();
  private decoder = new TextDecoder("utf-8", { fatal: false });

  reset(): void {
    this.tail = "";
    this.seen.clear();
  }

  // Feed a chunk of raw terminal bytes. Returns any URLs that were detected
  // for the first time during this call.
  feed(bytes: Uint8Array, host: string): DetectedUrl[] {
    // stream:true so multi-byte chars don't get mangled across chunks.
    const decoded = this.decoder.decode(bytes, { stream: true });
    if (decoded.length === 0) return [];

    const haystack = (this.tail + decoded).replaceAll(ANSI_RE, "");

    const out: DetectedUrl[] = [];
    let lastEnd = 0;
    URL_RE.lastIndex = 0;
    for (;;) {
      const m = URL_RE.exec(haystack);
      if (!m) break;
      lastEnd = URL_RE.lastIndex;
      const port = Number(m[1]);
      if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
      const url = rewriteHost(m[0], host);
      if (this.seen.has(url)) continue;
      this.seen.add(url);
      out.push({ url, port });
    }

    // Keep the unmatched tail so the next chunk can complete a split URL.
    // Also drop processed prefix so memory stays bounded even when nothing
    // matches.
    const tailStart = Math.max(lastEnd, haystack.length - PreviewUrlDetector.TAIL_BYTES);
    this.tail = haystack.slice(tailStart);
    return out;
  }
}

// rewriteHost swaps the loopback host in `original` for the remote host the
// user reaches aura-server through. Port and path are preserved verbatim. We
// keep the original scheme: dev servers usually serve plain http, but if the
// user happened to print an https URL we want to honor it.
function rewriteHost(original: string, host: string): string {
  return original.replace(
    /^(https?:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])/i,
    `$1${host}`,
  );
}

// previewHost extracts the hostname of the aura-server URL — the same
// substitution rule difit-client uses, lifted here so URL detection works
// without a difit dependency.
export function previewHost(cfg: ServerConfig): string {
  const cleaned = cfg.url.replace(/^ws(s?):\/\//, "http$1://");
  try {
    return new URL(cleaned).hostname;
  } catch {
    const m = cleaned.match(/^(?:https?:\/\/)?([^/:]+)/);
    return m ? m[1] : cleaned;
  }
}
