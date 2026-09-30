/**
 * Upstash QStash request signatures, checked without a dependency. Server only.
 *
 * QStash signs every call it makes with a JWT in the `Upstash-Signature` header: HS256 (HMAC-SHA256 over
 * `header.payload`) with the project's current signing key, or the next one while keys are being rotated. The payload
 * names the issuer (`iss` "Upstash"), the destination URL (`sub`), a validity window (`nbf`, `exp`, in seconds) and the
 * SHA-256 of the raw request body (`body`, base64url). A call passes only when all of these hold; anything else is
 * refused and nothing runs. The keys are read from the environment (docs/system/variables.md) and never logged.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";

/** Clock difference tolerated on `nbf` and `exp`. */
export const QSTASH_LEEWAY_S = 30;
const B64URL = /^[A-Za-z0-9_-]+$/;

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Constant-time equality of the HMAC of `signed` under `key` and the token's signature bytes. */
function signedWith(key: string, signed: string, sig: Buffer): boolean {
  const want = createHmac("sha256", key).update(signed).digest();
  return want.length === sig.length && timingSafeEqual(want, sig);
}

/**
 * Is this a genuine QStash call for `path`, carrying exactly `rawBody`? `keys` defaults to
 * `QSTASH_CURRENT_SIGNING_KEY` then `QSTASH_NEXT_SIGNING_KEY`; with neither set, every call is refused.
 */
export function verifyQstash(
  signature: string | null | undefined,
  rawBody: string,
  opts: { path: string; now?: number; keys?: (string | undefined)[] },
): boolean {
  const keys = (opts.keys ?? [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY]).filter((k): k is string => typeof k === "string" && k.length > 0);
  if (!keys.length || typeof signature !== "string" || signature.length > 4096) return false;
  const parts = signature.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64URL.test(p))) return false;
  const [h, p, s] = parts;
  const header = decodeJson(h);
  if (!header || header.alg !== "HS256") return false;
  const sig = Buffer.from(s, "base64url");
  // Every key is tried, so a token signed with the next key passes during a rotation.
  const good = keys.map((k) => signedWith(k, `${h}.${p}`, sig)).some(Boolean);
  if (!good) return false;
  const claims = decodeJson(p);
  if (!claims) return false;
  const now = (opts.now ?? Date.now()) / 1000;
  if (claims.iss !== "Upstash") return false;
  if (typeof claims.sub !== "string" || !claims.sub.endsWith(opts.path)) return false;
  if (typeof claims.nbf !== "number" || typeof claims.exp !== "number") return false;
  if (now < claims.nbf - QSTASH_LEEWAY_S || now > claims.exp + QSTASH_LEEWAY_S) return false;
  if (typeof claims.body !== "string") return false;
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("base64url");
  const claimed = claims.body.replace(/=+$/, "");
  const a = Buffer.from(bodyHash), b = Buffer.from(claimed);
  return a.length === b.length && timingSafeEqual(a, b);
}
