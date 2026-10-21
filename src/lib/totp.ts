import { createHash, createHmac, randomBytes } from "crypto";
import { westernDigits } from "./verify-client";
import { sameSecret } from "./secret";

/**
 * Time-based one-time codes (RFC 6238 over RFC 4226, HMAC-SHA1, 6 digits, 30-second steps), the codes every
 * authenticator app shows. About thirty lines of `crypto`, so no dependency (rules 1370-1372). Pure: no store, no
 * clock of its own. The founder console's second factor (src/lib/admin-2fa.ts) is the only user.
 */
export const TOTP_STEP = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now a code is still accepted: a phone clock 30 seconds off still works. */
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding: how authenticator apps take a secret typed by hand or read from the otpauth URI. */
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 back to bytes; spaces, dashes and case are ignored. Null for any other character. */
export function fromBase32(s: string): Buffer | null {
  const clean = s.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (the RFC's recommended size for SHA-1), base32. */
export const newTotpSecret = () => base32(randomBytes(20));

/** The HOTP value for one counter, `digits` long with leading zeros. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The 30-second step a time (ms) falls in. */
export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP);

/**
 * The step a code matches, now or `TOTP_WINDOW` steps either side, else null. Every candidate is computed and compared
 * with `sameSecret` (constant time), whichever matches. The caller burns the step it gets back, so a code never works twice.
 */
export function totpMatch(secretB32: string, code: string, nowMs: number): number | null {
  const key = fromBase32(secretB32);
  const given = westernDigits(code).replace(/\s/g, "");
  if (!key || key.length === 0 || !/^\d{6}$/.test(given)) return null;
  const now = totpStep(nowMs);
  let hit: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    if (sameSecret(hotp(key, now + d), given) && hit === null) hit = now + d;
  }
  return hit;
}

/** What an authenticator app opens: the secret, the issuer and the account label. */
export function otpauthUri(secretB32: string, label: string, issuer = "Thakeen"): string {
  const l = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${l}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

/** The one recovery code: 20 base32 characters (100 bits) in four groups of five, shown once. */
export function newRecoveryCode(): string {
  return base32(randomBytes(13)).slice(0, 20).replace(/(.{5})(?=.)/g, "$1-");
}

const cleanRecovery = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

/** How the recovery code is kept: a SHA-256 of the code without dashes, spaces or case, never the code itself. */
export function recoveryHash(code: string): string {
  return createHash("sha256").update(`nashr-admin-2fa-recovery:${cleanRecovery(code)}`).digest("hex");
}

/** A recovery code as typed: 20 base32 characters once dashes and spaces are dropped. */
export const looksLikeRecovery = (s: string) => /^[A-Z2-7]{20}$/.test(cleanRecovery(s));
