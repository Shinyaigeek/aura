// Verifies that an incoming HTTP request really came from Alexa, not an
// impostor. This is load-bearing security: the endpoint can type into a live
// Claude Code session, so an unverified POST = remote keystroke injection.
//
// Implements Amazon's documented procedure for custom skills hosted on your own
// HTTPS endpoint:
//   1. SignatureCertChainUrl points at a real Amazon cert (URL shape check).
//   2. The leaf cert is currently valid and lists echo-api.amazon.com in its
//      Subject Alternative Names.
//   3. Each cert in the chain is signed by the next (chain integrity).
//   4. The request body's RSA-SHA1 signature verifies against the leaf cert.
//   5. The request timestamp is within 150s (replay protection).
//   6. The skill's applicationId matches ours.
//
// Cert chains are cached in module scope (per isolate) keyed by URL so we don't
// refetch on every utterance.
//
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html

import { X509Certificate, X509Certificates, SubjectAlternativeNameExtension } from "@peculiar/x509";

const VALIDATION_HOST = "s3.amazonaws.com";
const VALIDATION_PATH_PREFIX = "/echo.api/";
const SAN_DNS = "echo-api.amazon.com";
const MAX_TIMESTAMP_SKEW_MS = 150_000;

const chainCache = new Map<string, X509Certificate[]>();

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Validate the SignatureCertChainUrl per Amazon's rules. */
function isValidCertUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname.toLowerCase() !== VALIDATION_HOST) return false;
  if (u.port && u.port !== "443") return false;
  // Normalize away any "/../" before checking the prefix.
  const path = u.pathname.replace(/\/+/g, "/");
  return path.startsWith(VALIDATION_PATH_PREFIX);
}

async function loadChain(url: string): Promise<X509Certificate[]> {
  const cached = chainCache.get(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const pem = await res.text();
  const chain = new X509Certificates();
  chain.import(pem);
  const certs = Array.from(chain);
  if (certs.length === 0) throw new Error("empty cert chain");
  chainCache.set(url, certs);
  return certs;
}

/** RSA-SHA1 signature of `body` against the leaf cert's public key. */
async function signatureValid(
  leaf: X509Certificate,
  signatureB64: string,
  body: ArrayBuffer
): Promise<boolean> {
  const key = await leaf.publicKey.export({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, ["verify"]);
  const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, body);
}

export async function verifyAlexaRequest(
  req: Request,
  body: ArrayBuffer,
  parsed: {
    request?: { timestamp?: string };
    context?: { System?: { application?: { applicationId?: string } } };
    session?: { application?: { applicationId?: string } };
  },
  expectedAppId: string
): Promise<VerifyResult> {
  const certUrl = req.headers.get("SignatureCertChainUrl") ?? req.headers.get("signaturecertchainurl");
  const signature = req.headers.get("Signature") ?? req.headers.get("signature");
  if (!certUrl || !signature) return { ok: false, reason: "missing signature headers" };
  if (!isValidCertUrl(certUrl)) return { ok: false, reason: "bad cert url" };

  let certs: X509Certificate[];
  try {
    certs = await loadChain(certUrl);
  } catch (e) {
    return { ok: false, reason: `cert load: ${(e as Error).message}` };
  }

  const leaf = certs[0];
  const now = new Date();
  if (now < leaf.notBefore || now > leaf.notAfter) return { ok: false, reason: "cert expired" };

  // SAN must list echo-api.amazon.com as a DNS name.
  const san = leaf.getExtension(SubjectAlternativeNameExtension);
  const hasDns = !!san && san.names.items.some((n) => n.type === "dns" && n.value === SAN_DNS);
  if (!hasDns) return { ok: false, reason: "SAN mismatch" };

  // Chain integrity: each cert signed by the next one up.
  for (let i = 0; i < certs.length - 1; i++) {
    const okLink = await certs[i].verify({ publicKey: certs[i + 1].publicKey, signatureOnly: true }).catch(() => false);
    if (!okLink) return { ok: false, reason: "broken cert chain" };
  }

  if (!(await signatureValid(leaf, signature, body))) return { ok: false, reason: "bad signature" };

  // Replay protection.
  const ts = parsed.request?.timestamp;
  if (!ts) return { ok: false, reason: "no timestamp" };
  const skew = Math.abs(now.getTime() - new Date(ts).getTime());
  if (Number.isNaN(skew) || skew > MAX_TIMESTAMP_SKEW_MS) return { ok: false, reason: "stale timestamp" };

  // Right skill. Present on context.System for every request type; session is
  // absent on SessionEndedRequest, so prefer context.
  const appId =
    parsed.context?.System?.application?.applicationId ?? parsed.session?.application?.applicationId;
  if (appId !== expectedAppId) return { ok: false, reason: "applicationId mismatch" };

  return { ok: true };
}
