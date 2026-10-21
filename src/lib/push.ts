import { createECDH, createHash, createPrivateKey, sign, type JsonWebKey } from "crypto";
import { db } from "./db";
import { log } from "./log";
import { accountKey, scopeParam, wsKey, type Scope } from "./keys";
import { safeFetch } from "./safe-fetch";
import { appOrigin } from "./origin";
import { pmap } from "./parallel";
import { agentById, isAgentId, type AgentId } from "./agents";
import { pushStateOf, STATUS_COPY } from "./agent-status";
import type { Activity } from "./activity";
import { AWAY_MINUTES } from "./push-beat";

export { AWAY_MINUTES, BEAT_SECONDS } from "./push-beat";

/**
 * Phone notifications through the browser's own push service (Web Push, rules 2560-2572), for the installed app (PWA,
 * rules 681-684) and any browser that supports it. Off until the founder sets both VAPID variables on the host
 * (docs/system/variables.md); with either missing or malformed nothing here runs and the app shows no switch.
 *
 * The push carries no content (rule 2567): the request to the push service has no body, so nothing is encrypted and no
 * draft, brand or name leaves the server that way. The device's worker (public/sw.js) wakes and reads the short text
 * from GET /api/push/latest with its own session: one agent's name and its state, nothing more.
 *
 * Who gets one: a subscription stored under the workspace (`wsKey.pushSubs(sc(u))`) by a login that has no app tab
 * visible right now (`accountKey.tabSeen`, a heartbeat with `AWAY_MINUTES` of life). Which rows send one:
 * `pushStateOf` (an agent now waits for the owner, or is stuck), once per agent and state per `PUSH_REPEAT_MINUTES`.
 */

/** One push per workspace, agent and state in this window, however many rows arrive (rule 2566). */
export const PUSH_REPEAT_MINUTES = 30;
/** Devices per workspace; a new one past this replaces the oldest (rule 2562). */
export const MAX_SUBS = 10;
/** How long the push service keeps a push for a device that is off (seconds). Past it the notice is stale. */
export const PUSH_TTL_SECONDS = 6 * 3600;
/** The push text a worker reads lives this long (rule 2567). */
export const PUSH_LAST_SECONDS = 86_400;
/** Subscribe, unsubscribe and the worker's reads per login and hour (rule 2562); heartbeats per login and hour (rule 2564). */
export const PUSH_CALLS_PER_HOUR = 60;
export const BEATS_PER_HOUR = 120;
export const ENDPOINT_MAX = 1024;

const b64u = (b: Buffer) => b.toString("base64url");

export type PushConfig = { publicKey: string; jwk: JsonWebKey };

/**
 * The VAPID key pair from the environment (rule 2560), or null: both `PUSH_VAPID_PUBLIC_KEY` (the uncompressed P-256
 * point, 65 bytes, base64url) and `PUSH_VAPID_PRIVATE_KEY` (the 32-byte scalar, base64url) must be there and be one
 * pair. Pure over `env`; never logs or returns the private part.
 */
export function pushConfig(env: Readonly<Record<string, string | undefined>> = process.env): PushConfig | null {
  const pub = env.PUSH_VAPID_PUBLIC_KEY?.trim(), priv = env.PUSH_VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  try {
    const p = Buffer.from(pub, "base64url"), d = Buffer.from(priv, "base64url");
    if (p.length !== 65 || p[0] !== 4 || d.length !== 32) return null;
    // The pair must match: Node signs with a JWK whose `d` belongs to another point, and every push would then fail.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(p)) return null;
    const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33)), d: b64u(d) };
    createPrivateKey({ key: jwk, format: "jwk" });
    return { publicKey: b64u(p), jwk };
  } catch {
    return null;
  }
}
export const pushOn = (env?: Readonly<Record<string, string | undefined>>) => pushConfig(env) !== null;
/** The public key a browser subscribes with, or null while push is off. Public by design (the `applicationServerKey`). */
export const pushPublicKey = (env?: Readonly<Record<string, string | undefined>>) => pushConfig(env)?.publicKey ?? null;

/**
 * The browsers' own push services, and nothing else (rule 2561): Chrome and Android (FCM), Firefox (Mozilla autopush),
 * Safari on iPhone, iPad and Mac (Apple), Edge (WNS). A subscription naming any other host is refused, so the server
 * never posts to an address a request chose.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** A subscription endpoint from a request, normalized, or null (rule 2561): https, a push service host, no credentials or port. */
export function pushEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > ENDPOINT_MAX) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  return PUSH_HOSTS.some((h) => h.test(u.hostname)) ? u.toString() : null;
}

/** The hash field of one device: never the endpoint itself, which is long and a capability. */
export const subId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

export type PushSub = { endpoint: string; login: string; at: string };
const isSub = (v: unknown): v is PushSub => {
  const o = (typeof v === "string" ? safeParse(v) : v) as Partial<PushSub> | null;
  return !!o && typeof o === "object" && typeof o.endpoint === "string" && typeof o.login === "string" && typeof o.at === "string";
};
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
const asSub = (v: unknown): PushSub => (typeof v === "string" ? (JSON.parse(v) as PushSub) : (v as PushSub));

/**
 * The login a push route acts for (rule 2562), normalized, or null: only a person's own session, an owner or a member.
 * An MCP token has no device, and a founder viewing an account must never subscribe a device to it nor mark its owner
 * present (the founder's actor carries the owner's address).
 */
export function pushLogin(actor: { kind: string; email: string } | undefined): string | null {
  if (!actor || (actor.kind !== "owner" && actor.kind !== "member")) return null;
  const login = actor.email.trim().toLowerCase();
  return login || null;
}

/** The workspace's devices, newest first; unreadable fields are skipped. */
export async function listSubscriptions(s: Scope): Promise<(PushSub & { id: string })[]> {
  const all = await db.hgetall<unknown>(wsKey.pushSubs(s));
  return Object.entries(all)
    .filter(([, v]) => isSub(v))
    .map(([id, v]) => ({ id, ...asSub(v) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Store this device under the caller's workspace (rule 2562): one field per endpoint, so subscribing again only
 * refreshes it; past `MAX_SUBS` the oldest go. One read, then the writes together.
 */
export async function saveSubscription(s: Scope, login: string, endpoint: string, now: Date = new Date()): Promise<void> {
  const id = subId(endpoint);
  const others = (await listSubscriptions(s)).filter((x) => x.id !== id);
  const drop = others.slice(MAX_SUBS - 1).map((x) => x.id);
  await Promise.all([
    db.hset(wsKey.pushSubs(s), id, { endpoint, login, at: now.toISOString() } satisfies PushSub),
    ...drop.map((k) => db.hdel(wsKey.pushSubs(s), k)),
  ]);
}

/** Remove this device from the caller's workspace (rule 2563). Only the field the endpoint names; a stranger's stays. */
export async function removeSubscription(s: Scope, endpoint: string): Promise<void> {
  await db.hdel(wsKey.pushSubs(s), subId(endpoint));
}

/** A visible tab of this login said "I am here" (rule 2564): the marker lives `AWAY_MINUTES`. */
export async function markSeen(login: string): Promise<void> {
  await db.set(accountKey.tabSeen(login), 1, AWAY_MINUTES * 60);
}

/**
 * The VAPID token (RFC 8292, rule 2568): ES256 over `{ aud, exp, sub }`, `aud` the push service's origin, `exp` 12
 * hours ahead (the services accept at most 24), `sub` our own origin.
 */
export function vapidJwt(cfg: PushConfig, audience: string, subject: string, nowS: number): string {
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: nowS + 12 * 3600, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(input), { key: createPrivateKey({ key: cfg.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}

export type SendResult = "ok" | "gone" | "failed";

/**
 * One empty push to one device (rules 2567-2568), through `safeFetch` with every hop https. 404 and 410 mean the
 * device unsubscribed or the subscription expired: the caller removes it. Never throws.
 */
export async function sendPush(cfg: PushConfig, endpoint: string, now: number = Date.now()): Promise<SendResult> {
  if (!pushEndpoint(endpoint)) return "gone";
  try {
    const jwt = vapidJwt(cfg, new URL(endpoint).origin, appOrigin(), Math.floor(now / 1000));
    const res = await safeFetch(endpoint, {
      method: "POST",
      headers: { TTL: String(PUSH_TTL_SECONDS), Urgency: "high", Authorization: `vapid t=${jwt}, k=${cfg.publicKey}` },
    }, { httpsOnly: true });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) log.warn("push refused", { status: res.status });
    return res.ok ? "ok" : "failed";
  } catch (e) {
    log.error("push send failed", e);
    return "failed";
  }
}

export type PushLast = { agent: AgentId; state: "waiting" | "stuck"; at: string };

/**
 * After rows were recorded in a workspace's activity log (rules 2565-2566): when push is on, one of the rows says an
 * agent now waits for the owner or is stuck, and a login with a device here has no tab visible, that device gets one
 * empty push. Stuck wins over waiting for the text. Answers how many devices were reached. Never throws.
 */
export async function pushForActivity(scope: string, rows: readonly Activity[], now: number = Date.now()): Promise<number> {
  try {
    const cfg = pushConfig();
    if (!cfg) return 0;
    const wanted = new Map<string, PushLast>();
    for (const r of rows) {
      const state = pushStateOf(r);
      if (state && r.agent && isAgentId(r.agent)) wanted.set(`${r.agent}:${state}`, { agent: r.agent, state, at: new Date(now).toISOString() });
    }
    if (!wanted.size) return 0;
    const s = scopeParam(scope);
    const subs = await listSubscriptions(s);
    if (!subs.length) return 0;
    const logins = [...new Set(subs.map((x) => x.login))];
    const seen = await db.mget<unknown>(logins.map(accountKey.tabSeen));
    const away = new Set(logins.filter((_, i) => seen[i] === null || seen[i] === undefined));
    const targets = subs.filter((x) => away.has(x.login));
    if (!targets.length) return 0;
    const items = [...wanted.values()];
    const claimed = await Promise.all(items.map((i) => db.lock(wsKey.pushSent(s, i.agent, i.state), PUSH_REPEAT_MINUTES * 60)));
    const go = items.filter((_, i) => claimed[i]);
    if (!go.length) return 0;
    const last = go.find((i) => i.state === "stuck") ?? go[0];
    await Promise.all([...away].map((l) => db.set(accountKey.pushLast(l), last, PUSH_LAST_SECONDS)));
    const results = await pmap(targets, (t) => sendPush(cfg, t.endpoint, now), 6);
    const gone = targets.filter((_, i) => results[i] === "gone");
    if (gone.length) await Promise.all(gone.map((t) => db.hdel(wsKey.pushSubs(s), t.id)));
    return results.filter((r) => r === "ok").length;
  } catch (e) {
    log.error("push for activity failed", e);
    return 0;
  }
}

/**
 * The text a woken worker shows (rule 2567): the app's short name as the title, "agent: state" as the body, in the
 * reader's language. The generic line when there is nothing (expired, read by another device first, never set).
 */
export function pushText(last: unknown, lang: "ar" | "en"): { title: string; body: string; href: string } {
  const c = STATUS_COPY[lang];
  const title = lang === "ar" ? "ذكين" : "Thakeen";
  const href = `/${lang}/app`;
  const v = (typeof last === "string" ? safeParse(last) : last) as Partial<PushLast> | null;
  if (!v || !isAgentId(v.agent) || (v.state !== "waiting" && v.state !== "stuck")) return { title, body: c.generic, href };
  return { title, body: `${agentById(v.agent).name[lang]}: ${c.state[v.state]}`, href };
}
