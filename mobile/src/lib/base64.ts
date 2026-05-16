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
