import { createHash } from "crypto";
import { createAdapterFactory } from "better-auth/adapters";
import { db } from "@/lib/db";
import { globalKey, storedPersonId, type PersonId } from "@/lib/keys";
import { dropSession, getLogin, issueSession, normalizeEmail, sessionForEngine, sessionKey, sessionRecord, SESSION_TOKEN, SESSION_TTL, type Login } from "@/lib/auth";
import { getPerson } from "@/lib/person";
import { loginEmail } from "@/lib/login-finish";
import { deviceId, forgetDevice } from "@/lib/devices";
import { linkKey, subKey } from "@/lib/google-signin";
import { takeApproval } from "./approvals";

/**
 * better-auth's database, read from Thakeen's own records (docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md
 * section 3, rules 3403-3409). No copy and no migration: every better-auth model is a PROJECTION of the records the
 * legacy engine reads and writes, so the two engines can never disagree and a rollback has nothing to undo.
 *
 * | model          | read from                                                    | writes                                       |
 * | user           | `getLogin(email)`; by id `getPerson(pid)` then `getLogin`    | none                                         |
 * | account        | the person's `passHash`, the `googlesub:`/`google:` link     | none                                         |
 * | session        | `session:h:{sha256}` through `sessionForEngine`              | create = `issueSession` for an approved token |
 * | verification   | `ba:verify:{sha256(identifier)}`                             | create with TTL, delete, consume = GETDEL    |
 *
 * Reads it does not support answer nothing (null, []), writes it does not support throw: better-auth's endpoints that
 * would need them are closed by the route's allow-list (rule 3413), so reaching one is a bug that must be loud.
 * Every key comes from src/lib/keys.ts; no `await db.*` inside a loop.
 */

type Row = Record<string, unknown>;
type Cond = { field: string; value: unknown; operator: string; connector: "AND" | "OR"; mode?: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown, fallback = 0): string => {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return new Date(Number.isFinite(t) ? t : fallback).toISOString();
};
/** A short, stable id for an account row: never the address or the Google id themselves. */
const rowId = (kind: string, pid: string) => sha(["ba-account", kind, pid].join(":")).slice(0, 24);

/** The value an `eq` condition on `field` asks for, when the conditions are a plain AND of `eq`s that include it. */
function eqValue(where: Cond[] | undefined, field: string): string | null {
  if (!where?.length || where.some((w) => w.connector === "OR")) return null;
  const w = where.find((c) => c.field === field && (c.operator ?? "eq") === "eq");
  return w && typeof w.value === "string" ? w.value : null;
}

const cmp = (a: unknown, b: unknown): number => {
  const x = a instanceof Date ? a.getTime() : typeof a === "string" && /^\d{4}-\d\d-\d\dT/.test(a) ? Date.parse(a) : a;
  const y = b instanceof Date ? b.getTime() : typeof b === "string" && /^\d{4}-\d\d-\d\dT/.test(b) ? Date.parse(b) : b;
  return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
};
/** One condition on one row. An operator this adapter does not know never matches (fail closed). */
function holds(row: Row, w: Cond): boolean {
  const v = row[w.field];
  switch (w.operator ?? "eq") {
    case "eq": return v === w.value || (v instanceof Date && cmp(v, w.value) === 0);
    case "ne": return v !== w.value;
    case "in": return Array.isArray(w.value) && (w.value as unknown[]).includes(v);
    case "not_in": return Array.isArray(w.value) && !(w.value as unknown[]).includes(v);
    case "lt": return cmp(v, w.value) < 0;
    case "lte": return cmp(v, w.value) <= 0;
    case "gt": return cmp(v, w.value) > 0;
    case "gte": return cmp(v, w.value) >= 0;
    default: return false;
  }
}
/** better-auth's where list: conditions joined left to right by each one's connector. */
export function matches(row: Row, where: Cond[] | undefined): boolean {
  if (!where?.length) return true;
  let ok = holds(row, where[0]);
  for (const w of where.slice(1)) ok = w.connector === "OR" ? ok || holds(row, w) : ok && holds(row, w);
  return ok;
}

// ---- pure projections (also used by scripts/better-auth-check.ts) ----

export type BaUser = { id: string; email: string; name: string; emailVerified: boolean; image: null; createdAt: string; updatedAt: string };
/**
 * A login as better-auth's user (rule 3403). `id` is the person id, `email` the login address. `emailVerified` is always
 * true (section 4.4): better-auth's magic link would otherwise run `revokeUnprovenAccountAccess` and erase the password
 * and every session of an owner who has not proved the address; Thakeen's own verification gate (rules 751, 767) stays
 * the only one, in `resolveSession` and the session gate.
 */
export function projectUser(l: Login): BaUser {
  const created = iso(l.person.createdAt);
  return { id: l.pid, email: normalizeEmail(loginEmail(l)), name: typeof l.person.name === "string" ? l.person.name : "", emailVerified: true, image: null, createdAt: created, updatedAt: created };
}

export type BaAccount = { id: string; accountId: string; providerId: "credential" | "google"; userId: string; password: string | null; accessToken: null; refreshToken: null; idToken: null; accessTokenExpiresAt: null; refreshTokenExpiresAt: null; scope: null; createdAt: string; updatedAt: string };
/**
 * A login's ways in as better-auth's accounts (rule 3404): `credential` when the person has a password hash (bcrypt,
 * checked by the same `bcryptjs` the legacy route uses), `google` when the login's Google link holds both ways
 * (`googlesub:{login}` names a sub whose `google:{sub}` names this login back). Passkeys stay Thakeen's (section 4.2).
 */
export function projectAccounts(l: Login, googleSub: string | null): BaAccount[] {
  const created = iso(l.person.createdAt);
  const base = { userId: l.pid as string, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scope: null, createdAt: created, updatedAt: created } as const;
  const out: BaAccount[] = [];
  if (typeof l.person.passHash === "string" && l.person.passHash.length > 0) out.push({ ...base, id: rowId("credential", l.pid), accountId: l.pid, providerId: "credential", password: l.person.passHash });
  if (googleSub) out.push({ ...base, id: rowId("google", l.pid), accountId: googleSub, providerId: "google", password: null });
  return out;
}

export type BaSession = { id: string; token: string; userId: string; expiresAt: string; createdAt: string; updatedAt: string; ipAddress: string; userAgent: string };
/**
 * A stored session as better-auth's session (rule 3406). Nothing better-auth-specific is stored: `id` is the device id
 * the device list uses, `createdAt` the issue time, `expiresAt` 30 days after it. The record's own TTL is the authority:
 * a record that still exists is live, so a projected expiry in the past (a record from before `at` was written) is moved
 * a minute ahead rather than letting better-auth delete a session the legacy engine still honours.
 */
export function projectSession(token: string, at: number, pid: string, now = Date.now()): BaSession {
  const created = iso(at);
  const exp = Math.max(at + SESSION_TTL * 1000, now + 60_000);
  return { id: deviceId(sessionKey(token)), token, userId: pid, expiresAt: new Date(exp).toISOString(), createdAt: created, updatedAt: created, ipAddress: "", userAgent: "" };
}

// ---- reads ----

/** The login of a person id this adapter projected itself (a session's `userId`): forward-checked through the login index. */
export async function loginOfPerson(raw: string): Promise<Login | null> {
  const pid: PersonId = storedPersonId(raw);
  const person = await getPerson(pid);
  if (!person) return null;
  const l = await getLogin(person.email);
  return l && l.pid === pid ? l : null;
}

/** The Google sub linked to this login, only when the link holds both ways. Two reads, the second needs the first. */
async function googleSubOf(login: string): Promise<string | null> {
  const sub = await db.get<string>(subKey(login));
  if (typeof sub !== "string" || !sub) return null;
  const back = await db.get<string>(linkKey(sub));
  return typeof back === "string" && normalizeEmail(back) === normalizeEmail(login) ? sub : null;
}

async function findUser(where: Cond[]): Promise<BaUser | null> {
  const email = eqValue(where, "email");
  const id = eqValue(where, "id");
  let l: Login | null = null;
  if (email) {
    const e = normalizeEmail(email);
    l = await getLogin(e);
    if (l && projectUser(l).email !== e) l = null;
  } else if (id) {
    l = await loginOfPerson(id);
  }
  if (!l) return null;
  const u = projectUser(l);
  return matches(u, where) ? u : null;
}

async function findAccounts(where: Cond[] | undefined): Promise<BaAccount[]> {
  const userId = eqValue(where, "userId");
  if (!userId) return []; // by provider and account id: only better-auth's Google callback, closed while BA_GOOGLE is off
  const l = await loginOfPerson(userId);
  if (!l) return [];
  const rows = projectAccounts(l, await googleSubOf(loginEmail(l)));
  return rows.filter((r) => matches(r, where));
}

async function findSession(where: Cond[]): Promise<BaSession | null> {
  const token = eqValue(where, "token");
  if (!token) return null; // by id or user: list and revoke are closed (rules 1938-1941 need the password)
  const hit = await sessionForEngine(token);
  if (!hit) return null;
  const s = projectSession(token, hit.session.at, hit.pid);
  return matches(s, where) ? s : null;
}

// ---- verification rows (the magic link) ----

const VERIFY_MAX_TTL = 60 * 60; // a magic link lives 15 minutes; nothing better-auth stores here should outlive an hour
type Verification = { id: string; identifier: string; value: string; expiresAt: string; createdAt: string; updatedAt: string };
const HEX64 = /^[0-9a-f]{64}$/;
/** A row's key: its id IS the SHA-256 hex of its identifier, so `consumeOne` by id and `findMany` by identifier meet. */
const verifyKey = (idHash: string) => globalKey.baVerify(idHash);

async function createVerification(data: Row): Promise<Verification> {
  const identifier = String(data.identifier ?? "");
  if (!identifier) throw new Error("ba_verification_identifier");
  const id = sha(identifier);
  const expires = Date.parse(String(data.expiresAt ?? ""));
  const ttl = Math.min(VERIFY_MAX_TTL, Math.ceil((expires - Date.now()) / 1000));
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("ba_verification_expiry");
  const row: Verification = { id, identifier, value: String(data.value ?? ""), expiresAt: iso(expires), createdAt: iso(data.createdAt, Date.now()), updatedAt: iso(data.updatedAt, Date.now()) };
  await db.set(verifyKey(id), row, ttl);
  return row;
}

/** The key a verification query names: by identifier (hashed here) or by id (already the hash). Null for anything else. */
function verificationKeyOf(where: Cond[] | undefined): string | null {
  const identifier = eqValue(where, "identifier");
  if (identifier) return verifyKey(sha(identifier));
  const id = eqValue(where, "id");
  return id && HEX64.test(id) ? verifyKey(id) : null;
}

async function findVerification(where: Cond[] | undefined): Promise<Verification | null> {
  const k = verificationKeyOf(where);
  if (!k) return null;
  const row = await db.get<Verification>(k);
  return row && matches(row, where) ? row : null;
}

// ---- writes ----

/**
 * The only session better-auth may write (rule 3407): one the session gate approved in this request, written by
 * `issueSession`, the code `createSession` runs, so the record, the cookie and the device entry are a legacy session's.
 */
async function createSessionRow(data: Row): Promise<BaSession> {
  const token = String(data.token ?? "");
  const email = SESSION_TOKEN.test(token) ? takeApproval(token) : null;
  if (!email) throw new Error("ba_session_not_approved");
  const exp = Date.parse(String(data.expiresAt ?? ""));
  const ttl = Number.isFinite(exp) ? Math.max(60, Math.min(SESSION_TTL, Math.ceil((exp - Date.now()) / 1000))) : SESSION_TTL;
  await issueSession(token, email, ttl);
  const at = Date.now();
  return { ...projectSession(token, at, String(data.userId ?? "")), ipAddress: String(data.ipAddress ?? ""), userAgent: String(data.userAgent ?? "") };
}

/** Sign-out of one session (rule 3409): the record under both keys and its device entry, as `destroySession` does. */
async function deleteSessionRow(where: Cond[]): Promise<number> {
  const token = eqValue(where, "token");
  if (!token) throw new Error("ba_adapter_unsupported");
  const rec = await sessionRecord(token).catch(() => null);
  await dropSession(token);
  const s = typeof rec === "string" ? { email: rec } : rec;
  if (s && !("imp" in s && s.imp)) await forgetDevice(s.email, sessionKey(token)).catch(() => {});
  return rec ? 1 : 0;
}

const modelOf = (m: { model: string; modelKey?: string }) => m.modelKey ?? m.model;
const unsupported = (): never => {
  throw new Error("ba_adapter_unsupported");
};

/** The adapter factory better-auth's `database` option takes (src/lib/better-auth/server.ts). */
export const redisAdapter = () =>
  createAdapterFactory({
    config: {
      adapterId: "thakeen-redis",
      adapterName: "Thakeen Redis (projection)",
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: false,
      transaction: false,
    },
    adapter: () => ({
      async create({ model, modelKey, data }) {
        const m = modelOf({ model, modelKey });
        if (m === "session") return (await createSessionRow(data)) as unknown as typeof data;
        if (m === "verification") return (await createVerification(data)) as unknown as typeof data;
        return unsupported(); // user and account: sign-up, linking and profile edits stay Thakeen's
      },
      async update() {
        return unsupported(); // session refresh is off; users and accounts are not edited through better-auth
      },
      async updateMany() {
        return unsupported();
      },
      async findOne<T>({ model, modelKey, where }: { model: string; modelKey?: string; where: Cond[] }): Promise<T | null> {
        const m = modelOf({ model, modelKey });
        if (m === "user") return (await findUser(where)) as T | null;
        if (m === "session") return (await findSession(where)) as T | null;
        if (m === "account") return ((await findAccounts(where))[0] ?? null) as T | null;
        if (m === "verification") return (await findVerification(where)) as T | null;
        return null;
      },
      async findMany<T>({ model, modelKey, where, limit }: { model: string; modelKey?: string; where?: Cond[]; limit: number }): Promise<T[]> {
        const m = modelOf({ model, modelKey });
        let rows: unknown[] = [];
        if (m === "account") rows = await findAccounts(where);
        else if (m === "verification") rows = [await findVerification(where)].filter(Boolean);
        else if (m === "user" && where) rows = [await findUser(where)].filter(Boolean);
        else if (m === "session" && where) rows = [await findSession(where)].filter(Boolean);
        return rows.slice(0, Math.max(0, limit || rows.length)) as T[];
      },
      async delete({ model, modelKey, where }) {
        const m = modelOf({ model, modelKey });
        if (m === "session") { await deleteSessionRow(where); return; }
        if (m === "verification") { const k = verificationKeyOf(where); if (k) await db.del(k); return; }
        unsupported();
      },
      async deleteMany({ model, modelKey, where }) {
        const m = modelOf({ model, modelKey });
        if (m === "session") return deleteSessionRow(where);
        if (m === "verification") {
          const k = verificationKeyOf(where);
          if (!k) return 0; // the expiry sweep: Redis TTLs already end every row
          await db.del(k);
          return 1;
        }
        return unsupported();
      },
      /** Single use under concurrency (rule 3416): GETDEL, so of two verifies racing for one link exactly one gets it. */
      async consumeOne<T>({ model, modelKey, where }: { model: string; modelKey?: string; where: Cond[] }): Promise<T | null> {
        if (modelOf({ model, modelKey }) !== "verification") return unsupported();
        const k = verificationKeyOf(where);
        if (!k) return null;
        const row = await db.getdel<Verification>(k);
        return (row && matches(row, where) ? row : null) as T | null;
      },
      async count({ model, modelKey, where }) {
        const m = modelOf({ model, modelKey });
        if (m === "account") return (await findAccounts(where)).length;
        if (m === "verification") return (await findVerification(where)) ? 1 : 0;
        if (m === "session" && where) return (await findSession(where)) ? 1 : 0;
        if (m === "user" && where) return (await findUser(where)) ? 1 : 0;
        return 0;
      },
    }),
  });
