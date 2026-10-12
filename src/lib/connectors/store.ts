import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { db } from "../db";

/** Encrypted per-user connection records. AES-256-GCM with CONNECT_SECRET. */
export type Connection = {
  provider: string;
  data: Record<string, string>; // tokens / keys (encrypted at rest)
  meta?: Record<string, string>; // display info: account name, shop, site — plain
  connectedAt: string;
  expiresAt?: string;
  /** Set when the platform refused the token and a refresh could not fix it: the owner must connect again. */
  needsReconnect?: string;
};

/** Holds the OAuth state in the browser that started a connect flow; the callback requires it (see start/route.ts). */
export const OAUTH_COOKIE = "nashr_oauth";

/** Production must use its own CONNECT_SECRET: reusing the admin key would let one leaked secret decrypt every tenant's platform credentials. */
export function connectSecret(): string {
  const v = process.env.CONNECT_SECRET;
  if (v) return v;
  if (process.env.NODE_ENV === "production") throw new Error("CONNECT_SECRET is not set");
  return process.env.WAITLIST_ADMIN_KEY ?? "dev-only-insecure";
}

/**
 * Key versions (rule 1351, C-015). Every sealed connection record now names the key that sealed it: `kid`, the first 16
 * hex characters of SHA-256("kid:" + secret), a fingerprint that reveals nothing about the secret. To rotate, set
 * `CONNECT_SECRET` to the new value and `CONNECT_SECRET_PREVIOUS` to the old one: records sealed with either still open,
 * and each one is sealed with the new key the next time it is saved. A record whose `kid` matches neither key fails with
 * `connect_key_unknown` (the owner connects again) instead of an anonymous crypto error. A record written before
 * key versions has no `kid`: the current key is tried, then the previous one.
 *
 * Expand step of rule 679: the blob keeps its old `iv.tag.enc` shape and `kid` sits beside it, so a release from before
 * this change ignores `kid` and still opens every record sealed with the key it knows.
 */
const keyOf = (secret: string) => createHash("sha256").update(secret).digest();
export const kidOf = (secret: string) => createHash("sha256").update("kid:" + secret).digest("hex").slice(0, 16);
/** The keys that may open a record: the current one first, then `CONNECT_SECRET_PREVIOUS` when it is set and differs. */
function keyring(): { kid: string; key: Buffer }[] {
  const current = connectSecret();
  const previous = process.env.CONNECT_SECRET_PREVIOUS;
  const ring = [{ kid: kidOf(current), key: keyOf(current) }];
  if (previous && previous !== current) ring.push({ kid: kidOf(previous), key: keyOf(previous) });
  return ring;
}
/** The fingerprint of the key `encrypt` seals with now. */
export const currentKid = () => kidOf(connectSecret());

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyring()[0].key, iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
function open(blob: string, key: Buffer) {
  const [iv, tag, enc] = blob.split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}
/** Open a blob: with the key `kid` names when given, else the current key, then the previous one. */
export function decrypt(blob: string, kid?: string) {
  const ring = keyring();
  if (kid) {
    const k = ring.find((r) => r.kid === kid);
    if (!k) throw new Error("connect_key_unknown");
    return open(blob, k.key);
  }
  for (let i = 0; i < ring.length; i++) {
    try {
      return open(blob, ring[i].key);
    } catch (e) {
      if (i === ring.length - 1) throw e;
    }
  }
  throw new Error("connect_key_unknown");
}

/** `kid`: the key that sealed `enc` (rule 1351); absent on a record written before key versions. */
type Stored = Omit<Connection, "data"> & { enc: string; kid?: string };

export async function saveConnection(email: string, c: Connection) {
  const s: Stored = { provider: c.provider, meta: c.meta, connectedAt: c.connectedAt, expiresAt: c.expiresAt, needsReconnect: c.needsReconnect, enc: encrypt(JSON.stringify(c.data)), kid: currentKid() };
  await db.set(`conn:${email}:${c.provider}`, s);
  await db.sadd(`conns:${email}`, c.provider);
}
export async function getConnection(email: string, provider: string): Promise<Connection | null> {
  const s = await db.get<Stored>(`conn:${email}:${provider}`);
  if (!s) return null;
  return { provider: s.provider, meta: s.meta, connectedAt: s.connectedAt, expiresAt: s.expiresAt, needsReconnect: s.needsReconnect, data: JSON.parse(decrypt(s.enc, s.kid)) };
}
export async function listConnections(email: string): Promise<Omit<Connection, "data">[]> {
  const ids = await db.smembers(`conns:${email}`);
  const rows = await Promise.all(ids.map((id) => db.get<Stored>(`conn:${email}:${id}`)));
  return rows.filter((s): s is Stored => !!s).map((s) => ({ provider: s.provider, meta: s.meta, connectedAt: s.connectedAt, expiresAt: s.expiresAt, needsReconnect: s.needsReconnect }));
}
export async function deleteConnection(email: string, provider: string) {
  // Encrypted credentials go, and the provider leaves the index with them.
  await Promise.all([db.del(`conn:${email}:${provider}`), db.srem(`conns:${email}`, provider)]);
}
/** Short-lived OAuth state (10 min). */
export async function saveState(state: string, payload: Record<string, string>) {
  await db.set(`oauthstate:${state}`, payload, 600);
}
export async function takeState(state: string) {
  const p = await db.get<Record<string, string>>(`oauthstate:${state}`);
  if (p) await db.del(`oauthstate:${state}`);
  return p;
}
