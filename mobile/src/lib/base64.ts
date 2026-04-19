// Base64 helpers for the RN↔WebView bridge. `btoa`/`atob` exist in RN,
// but we roll our own for correctness on the byte path (btoa is latin1-only).

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
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
