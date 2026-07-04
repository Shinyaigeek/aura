// Base64 helpers for the RN↔WebView bridge. `btoa`/`atob` exist in RN,
// but we roll our own for correctness on the byte path (btoa is latin1-only).

export function bytesToBase64(bytes: Uint8Array): string {
  // Encode in chunks via String.fromCharCode.apply so we make a few thousand
  // calls instead of one-per-byte. On bursty terminal output (build logs,
  // tmux reattach redraws) the per-byte loop dominated flush time enough
  // that the JS↔native bridge stalled long enough for Android to post an
  // ANR ("aura is not responding") dialog. 8192 stays well under engine
  // argument-count limits across Hermes / JSC / V8.
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  // `btoa` is available on RN's JS runtime (Hermes).
  return globalThis.btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Decode a UTF-8 byte array to a JS string WITHOUT `new TextDecoder()`.
// TextDecoder throws on the release-build Hermes runtime (a launch crash from
// this exact call shipped in 0.0.35 via preview-url.ts). TextEncoder is fine on
// Hermes, but TextDecoder is not — so the outbound path (ws.ts / terminal-html)
// can keep using TextEncoder while any RN-side decode must be hand-rolled. This
// is on the copy/buffer-dump path: the previous `new TextDecoder().decode(...)`
// threw, got swallowed, and surfaced as an always-empty copy modal.
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else if (b0 >= 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      // Code points above U+FFFF become a UTF-16 surrogate pair.
      const cp = (((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3) - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    // A lone continuation byte (0x80-0xBF) is malformed; skip it.
  }
  return out;
}
