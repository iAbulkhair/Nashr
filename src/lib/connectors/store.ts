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

function key() {
  const secret = connectSecret();
  return createHash("sha256").update(secret).digest();
}
export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
export function decrypt(blob: string) {
  const [iv, tag, enc] = blob.split(".");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

type Stored = Omit<Connection, "data"> & { enc: string };

export async function saveConnection(email: string, c: Connection) {
  const s: Stored = { provider: c.provider, meta: c.meta, connectedAt: c.connectedAt, expiresAt: c.expiresAt, needsReconnect: c.needsReconnect, enc: encrypt(JSON.stringify(c.data)) };
  await db.set(`conn:${email}:${c.provider}`, s);
  await db.sadd(`conns:${email}`, c.provider);
}
export async function getConnection(email: string, provider: string): Promise<Connection | null> {
  const s = await db.get<Stored>(`conn:${email}:${provider}`);
  if (!s) return null;
  return { provider: s.provider, meta: s.meta, connectedAt: s.connectedAt, expiresAt: s.expiresAt, needsReconnect: s.needsReconnect, data: JSON.parse(decrypt(s.enc)) };
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
