import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { log } from "./log";
import { getLogin, type Login } from "./auth";
import { globalKey, personKey, storedPersonId, type PersonId } from "./keys";
import { PASSKEYS_MAX, PASSKEY_NAME_MAX } from "./passkey-limits";
import { getPerson, withPersonLock } from "./person";
import { parseStored, PasskeyCred, PasskeySet, type PasskeyCredValue, type PasskeySetValue } from "./stored";
import type { RegisteredCred } from "./webauthn";

/**
 * The customer passkey store (docs/specs/2026-10-20-passkeys.md, rules 2400-2425). Server only: it reads and writes the
 * store. One set per person, `passkeys:{pid}` (`PasskeySet`), and one reverse entry per credential,
 * `pkcred:{sha256(credentialId)}` → pid, written with SET NX so a credential id is held by one pid only (rule 2404).
 *
 * `born` is always the person's `createdAt` (`getPerson(pid).createdAt`, pre-flight ruling 1), passed by the caller. A
 * set stamped with another birth is ignored by every read and never deleted by one; only `ensureUid` and `addPasskey`,
 * inside the person lock, replace it, deleting its reverse entries that still name the pid (rule 2402). A set that does
 * not fit the shape at all (a later build's, rolled back: rule 679) reads as no passkeys and is never replaced:
 * `ensureUid` and `addPasskey` answer `invalid`, and only a wipe (`passkeyKeys`) or a move deletes it.
 *
 * Partial failures (Task 3 fix round 1): a reverse entry is deleted before the set that lists it is rewritten, and one
 * claimed with SET NX is released again when the set write after it throws, so no entry ever names a pid whose set does
 * not list it (such an entry would survive every wipe and block that credential id for good).
 *
 * Locks (rule 2414): every write to a set or a reverse entry runs under `lock:person:{pid}` with the set re-read inside
 * it, unless the caller already holds that lock (`personLocked`). Writes to an existing set use SET XX, so a set a wipe
 * or a move deleted meanwhile is never re-created under the old pid (rule 2422). No store call is awaited in a loop.
 *
 * The pid always comes from our own records (`actingLogin`, a move's resolved pids, or the reverse index forward-checked
 * in `resolvePasskeyLogin`), never from a request (rule 2400). The reverse-index key is built from a hash of a credential
 * id the browser sent: it is a lookup hint, re-checked against the forward records before it grants anything (rule 2405).
 */

/**
 * `personLocked`: the caller already holds `lock:person:{pid}` (locks are not reentrant, rule 2139). Otherwise the write
 * takes it, and throws `person_lock_timeout` (`isPersonLockTimeout`, answered 409 `busy`) when it stays taken.
 */
type Opts = { personLocked?: boolean };

/** SHA-256 hex (pre-flight ruling 20: a local helper, no shared one exists). */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The reverse-index hash of a credential id. */
export const credHash = (id: string): string => sha256(id);
/** The list reference of a credential: the first 16 hex characters of its hash (never the id itself, rule 2413). */
export const refOf = (id: string): string => credHash(id).slice(0, 16);
/** The 8-hex hash an audit row may carry instead of the credential id (rule 2421). */
export const shortHash = (id: string): string => credHash(id).slice(0, 8);

/** One passkey as the list shows it (rule 2413): no credential id, public key, AAGUID or counter. */
export type PasskeyItem = { ref: string; name: string; createdAt: string; lastUsedAt?: string; synced: boolean; transports: string[] };

/** Control characters and the bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069). */
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/** A passkey name: control and bidi-override characters dropped, trimmed, 1-40 characters, else null (rule 2401). */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(UNSAFE, "").trim();
  return s.length >= 1 && s.length <= PASSKEY_NAME_MAX ? s : null;
}

const setKey = (pid: PersonId) => personKey.passkeys(pid);
const revKey = (id: string) => globalKey.passkeyCred(credHash(id));
const run = <T,>(pid: PersonId, opts: Opts, fn: () => Promise<T>): Promise<T> => (opts.personLocked ? fn() : withPersonLock(pid, fn));

const parseSet = (raw: unknown): PasskeySetValue | null => parseStored("passkeys", PasskeySet, raw, null);
const fits = (set: PasskeySetValue | null, born: string | undefined): set is PasskeySetValue => !!set && set.born === born;
/** A new, empty set: a fresh 32-byte user handle (rule 2403) and the person's birth. */
function newSet(born: string | undefined): PasskeySetValue {
  const set: PasskeySetValue = { v: 1, uid: randomBytes(32).toString("base64url"), creds: [] };
  if (born !== undefined) set.born = born;
  return set;
}

const CRED_ID = /^[A-Za-z0-9_-]{16,1366}$/;
/**
 * The credential ids a stored set lists, read loosely so a set that no longer fits the shape still gives up its reverse
 * entries to a wipe or a replacement (bounded: a set is at most 10 credentials, a broken one is cut at 64).
 */
function idsOf(raw: unknown): string[] {
  const creds = raw && typeof raw === "object" ? (raw as { creds?: unknown }).creds : undefined;
  if (!Array.isArray(creds)) return [];
  const ids = creds.slice(0, 64).map((c) => (c && typeof c === "object" ? (c as { id?: unknown }).id : undefined));
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && CRED_ID.test(id)))];
}

/** The reverse-entry keys of `ids` that still name `pid`, read in one MGET (pre-flight ruling 22). */
async function ownedReverse(pid: PersonId, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const keys = ids.map(revKey);
  const vals = await db.mget<unknown>(keys);
  return keys.filter((_, i) => vals[i] !== null && String(vals[i]) === pid);
}

const itemOf = (c: PasskeyCredValue): PasskeyItem => ({
  ref: refOf(c.id),
  name: c.name,
  createdAt: c.createdAt,
  ...(c.lastUsedAt ? { lastUsedAt: c.lastUsedAt } : {}),
  synced: c.backedUp === true,
  transports: [...c.transports],
});

/** The person's set when it fits the shape and carries this birth; null otherwise. A read never deletes (rule 2402). */
export async function readSet(pid: PersonId, born: string | undefined): Promise<PasskeySetValue | null> {
  const set = parseSet(await db.get(setKey(pid)));
  return fits(set, born) ? set : null;
}

/** The person's passkeys as the security settings list shows them (rule 2413). */
export async function listPasskeys(pid: PersonId, born: string | undefined): Promise<PasskeyItem[]> {
  return (await readSet(pid, born))?.creds.map(itemOf) ?? [];
}

/**
 * Inside the person lock: the set to write to. A fitting set is returned as is (`written: true`). An absent one is a new
 * set not yet stored. A stale one (it fits the shape, another birth) is replaced now: its reverse entries that still name
 * the pid are deleted first, then the new set is written, so a failure in between leaves the stale set listing every
 * entry it still owns (rule 2402). A broken one (it does not fit the shape) is never replaced: `invalid` (rule 679).
 */
async function currentSet(pid: PersonId, born: string | undefined): Promise<{ set: PasskeySetValue; written: boolean } | "invalid"> {
  const raw = await db.get(setKey(pid));
  if (raw === null || raw === undefined) return { set: newSet(born), written: false };
  const set = parseSet(raw);
  if (!set) return "invalid";
  if (fits(set, born)) return { set, written: true };
  const fresh = newSet(born);
  const owned = await ownedReverse(pid, idsOf(raw));
  await Promise.all(owned.map((k) => db.del(k)));
  await db.set(setKey(pid), fresh);
  return { set: fresh, written: true };
}

/**
 * The person's WebAuthn user handle, creating the set (`{ v: 1, uid, born, creds: [] }`) when it is absent or stale
 * (rules 2402, 2403), as `{ uid }`; `invalid` when the stored set does not fit the shape (it is left as it is). The
 * result is a union the compiler makes the caller split (ruling N4). Under the person lock unless the caller holds it.
 */
export async function ensureUid(pid: PersonId, born: string | undefined, opts: Opts = {}): Promise<{ uid: string } | "invalid"> {
  return run(pid, opts, async () => {
    const cur = await currentSet(pid, born);
    if (cur === "invalid") return cur;
    if (!cur.written) await db.set(setKey(pid), cur.set);
    return { uid: cur.set.uid };
  });
}

/**
 * Adds a verified credential (rules 2401, 2404, 2414). The credential and its name are checked against `PasskeyCred`
 * before anything is locked or written: one that does not fit answers `invalid`. Under the person lock: the set re-read
 * (a stale one replaced, a broken one left as it is: `invalid`), the cap of 10, the reverse entry claimed with SET NX
 * (held by anyone, this pid included: `credential_taken`, nothing stored), then the credential appended. When that last
 * write throws, the set is re-read and the claimed entry released (best effort) unless the set lists it; then rethrown.
 */
export async function addPasskey(
  pid: PersonId,
  born: string | undefined,
  cred: RegisteredCred,
  name: unknown,
  opts: Opts = {},
): Promise<{ ok: true; item: PasskeyItem } | "limit" | "credential_taken" | "invalid"> {
  const parsed = PasskeyCred.safeParse({
    id: cred.id,
    pk: cred.pk,
    counter: cred.counter,
    transports: cred.transports,
    name: cleanName(name),
    createdAt: new Date().toISOString(),
    aaguid: cred.aaguid,
    backedUp: cred.backedUp,
  });
  if (!parsed.success) {
    log.warn("passkey refused", { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code })) });
    return "invalid";
  }
  const entry = parsed.data;
  return run(pid, opts, async () => {
    const cur = await currentSet(pid, born);
    if (cur === "invalid") return cur;
    const { set } = cur;
    if (set.creds.length >= PASSKEYS_MAX) return "limit" as const;
    if (set.creds.some((c) => c.id === entry.id)) return "credential_taken" as const;
    const rev = revKey(entry.id);
    if (!(await db.setNx(rev, pid))) return "credential_taken" as const;
    try {
      await db.set(setKey(pid), { ...set, creds: [...set.creds, entry] });
    } catch (e) {
      // The write may have landed before the error (an HTTP timeout): release the claim only when the set does not list
      // the credential (ruling N3). When even the re-read fails, release it: a listed passkey without its entry fails
      // closed and the person can remove it, while an entry no set lists would block that credential id for good.
      const raw = await db.get(setKey(pid)).catch(() => undefined);
      if (raw === undefined || !idsOf(raw).includes(entry.id)) await db.del(rev).catch(() => undefined);
      throw e;
    }
    return { ok: true as const, item: itemOf(entry) };
  });
}

/** Renames the credential whose `ref` is in the caller's own set (rule 2413). Under the person lock; SET XX. */
export async function renamePasskey(pid: PersonId, born: string | undefined, ref: string, name: unknown, opts: Opts = {}): Promise<"ok" | "not_found" | "invalid"> {
  const clean = cleanName(name);
  if (clean === null) return "invalid";
  return run(pid, opts, async () => {
    const set = await readSet(pid, born);
    const at = set ? set.creds.findIndex((c) => refOf(c.id) === ref) : -1;
    if (!set || at < 0) return "not_found" as const;
    const creds = set.creds.map((c, i) => (i === at ? { ...c, name: clean } : c));
    return (await db.setXx(setKey(pid), { ...set, creds })) ? ("ok" as const) : ("not_found" as const);
  });
}

/**
 * Removes the credential whose `ref` is in the caller's own set (rule 2416): the set keeps its `uid` even when empty, and
 * the reverse entry goes only while it still names this pid. Under the person lock; SET XX. The reverse entry is deleted
 * before the set is rewritten: a failure in between leaves the credential listed (a retry removes it), never an entry
 * the set no longer lists.
 */
export async function removePasskey(pid: PersonId, born: string | undefined, ref: string, opts: Opts = {}): Promise<"ok" | "not_found"> {
  return run(pid, opts, async () => {
    const set = await readSet(pid, born);
    const gone = set?.creds.find((c) => refOf(c.id) === ref);
    if (!set || !gone) return "not_found" as const;
    const creds = set.creds.filter((c) => c !== gone);
    const owned = await ownedReverse(pid, [gone.id]);
    await Promise.all(owned.map((k) => db.del(k)));
    return (await db.setXx(setKey(pid), { ...set, creds })) ? ("ok" as const) : ("not_found" as const);
  });
}

/**
 * The signature counter check (rule 2421): when both are 0 the authenticator keeps no counter; otherwise the new one
 * must be strictly greater than the stored one.
 */
export function counterOk(stored: number, next: number): boolean {
  return (stored === 0 && next === 0) || next > stored;
}

/**
 * Records a sign-in with `credId` (rules 2421, 2422), under the person lock: `counter` (with the stored value, for the
 * audit row) when the counter regressed, nothing written; `gone` when the set, its birth or the credential is gone, or the
 * set was deleted before the write (SET XX never re-creates it); else the counter and `lastUsedAt` are written.
 */
export async function recordUse(pid: PersonId, born: string | undefined, credId: string, newCounter: number): Promise<{ result: "ok" | "counter" | "gone"; stored?: number }> {
  return withPersonLock(pid, async () => {
    const set = await readSet(pid, born);
    const cur = set?.creds.find((c) => c.id === credId);
    if (!set || !cur) return { result: "gone" as const };
    const stored = cur.counter;
    if (!counterOk(stored, newCounter)) return { result: "counter" as const, stored };
    const now = new Date().toISOString();
    const creds = set.creds.map((c) => (c === cur ? { ...c, counter: newCounter, lastUsedAt: now } : c));
    const written = await db.setXx(setKey(pid), { ...set, creds });
    return { result: written ? ("ok" as const) : ("gone" as const), stored };
  });
}

/**
 * Every passkey key a wipe of `pid` deletes (rule 2425): the set, its reverse entries that still name the pid (pre-flight
 * ruling 22: one MGET, so a wipe never removes another person's entry) and the open registration. Whatever the set's
 * birth: a stale set is still this pid's.
 */
export async function passkeyKeys(pid: PersonId): Promise<string[]> {
  const raw = await db.get(setKey(pid));
  return [setKey(pid), ...(await ownedReverse(pid, idsOf(raw))), personKey.passkeyReg(pid)];
}

/**
 * What a move did (Task 3 fix round 2, ruling N5). `moved`: the set is at `to` (or a resumed move finished). `nothing`:
 * equal pids or no set under `from`. `dropped`: the `from` set was not the mover's (another birth, or broken) and went
 * with its own reverse entries. `kept_to`: `to` already held a live or broken set, which was kept, and the `from` set
 * went with its own reverse entries. `skipped`: a person could not be read and nothing was written. Both address moves
 * then log it, finish the rest of the move and keep `from`'s passkey keys (the member move skips their delete, the owner
 * move passes `keepPasskeys` to `wipeAccount`). Nothing retries the move, so they stay for good, inert: no login names the
 * old pid (rule 2405) and a later person there has another birth (rule 2402). Unreachable in practice: both persons are
 * read or written by the move just before.
 */
export type PasskeyMove = "moved" | "nothing" | "dropped" | "kept_to" | "skipped";

/**
 * Moves the set of `from` to `to` on an address move (rule 2424): the same `uid`, every reverse entry that names `from`
 * rewritten to `to` (compare-and-set, so an entry naming a third pid is never taken over, and an absent one is re-claimed
 * with SET NX), then `passkeys:{from}` and `pkreg:{from}` deleted. Both births are read here, inside the move: the set is
 * the mover's only when it carries `getPerson(from).createdAt`, and it is stamped with `getPerson(to).createdAt` (the
 * destination person, already written by the move: spec flow D). A move is the end of `from`, so a `from` set that is
 * not carried (another birth: a leftover of someone else, or a broken one) is dropped with its own reverse entries.
 *
 * Order (Task 3 fix rounds 1 and 2): `to` is written first (its stale entries released before it is overwritten), then
 * the reverse entries rewritten, then the reverse entries of `from` that `to` does not list, and only then the `from` set
 * and `pkreg:`. A failure at any step leaves the `from` set in place, so a retry finds `to` holding the same `uid`: then
 * `to` is authoritative (ruling N1). It is not rewritten; only the entries of credentials it lists that still name `from`
 * are pointed at it, and the rest of `from` goes with its entries that still name `from`. A passkey removed at `to`
 * between the two runs never comes back (one added only at `from` in between is lost; the person adds it again). When the
 * destination person was written again between the runs, `to` is re-stamped with its current birth (same `uid`, same
 * credentials).
 *
 * A live `to` (it carries the destination's birth, another `uid` and at least one passkey) or a broken one is never
 * overwritten: the `from` set is dropped with the reverse entries that still name `from` (the person adds those passkeys
 * again). A stale or empty `to` is replaced. With `personLocked: false` both person locks are taken, the smaller pid
 * first; both address moves pass `true` (each already holds both person locks, rule 2414).
 */
export async function movePasskeys(from: PersonId, to: PersonId, opts: { personLocked: boolean }): Promise<PasskeyMove> {
  if (from === to) return "nothing";
  const move = async (): Promise<PasskeyMove> => {
    const [rawFrom, rawTo, pFrom, pTo] = await Promise.all([db.get(setKey(from)), db.get(setKey(to)), getPerson(from), getPerson(to)]);
    if (rawFrom === null || rawFrom === undefined) return "nothing";
    if (!pFrom || !pTo) {
      log.warn("passkey move skipped", { reason: pFrom ? "to_person" : "from_person" });
      return "skipped";
    }
    const fromSet = parseSet(rawFrom);
    const toSet = parseSet(rawTo);
    const hasTo = rawTo !== null && rawTo !== undefined;
    const resumed = !!fromSet && !!toSet && toSet.uid === fromSet.uid;
    const carried = fromSet && (resumed || fits(fromSet, pFrom.createdAt)) ? fromSet : null;
    const keepTo = hasTo && !resumed && (!toSet || (fits(toSet, pTo.createdAt) && toSet.creds.length > 0));
    /** The `from` set and `pkreg:` go last, after every reverse entry of `from` that must go (no orphan if a delete fails). */
    const endFrom = async (gone: string[]) => {
      await Promise.all(gone.map((k) => db.del(k)));
      await Promise.all([db.del(setKey(from)), db.del(personKey.passkeyReg(from))]);
    };
    if (!carried || keepTo) {
      await endFrom(await ownedReverse(from, idsOf(rawFrom)));
      return carried ? "kept_to" : "dropped";
    }

    // The credentials `to` holds after the move: on a resumed move exactly what `to` lists (it is authoritative).
    const ids = (resumed && toSet ? toSet.creds : carried.creds).map((c) => c.id);
    const listed = new Set(ids);
    const leftover = carried.creds.map((c) => c.id).filter((id) => !listed.has(id));
    const staleTo = resumed ? [] : idsOf(rawTo).filter((id) => !listed.has(id));
    const all = [...ids, ...leftover, ...staleTo];
    const vals = all.length ? await db.mget<unknown>(all.map(revKey)) : [];
    const named = new Map(all.map((id, i) => [id, vals[i] === null || vals[i] === undefined ? null : String(vals[i])]));

    if (!resumed) {
      // 1. Release the replaced `to` set's own entries, then write `to`.
      await Promise.all(staleTo.filter((id) => named.get(id) === to).map((id) => db.del(revKey(id))));
      await db.set(setKey(to), { v: 1, uid: carried.uid, born: pTo.createdAt, creds: carried.creds } satisfies PasskeySetValue);
    } else if (toSet && toSet.born !== pTo.createdAt) {
      // 1'. A resume whose destination person was written again between the runs (another birth): `to` keeps its uid and
      //     credentials and takes the current birth, or reads would ignore it (Task 6, parked minor A).
      await db.set(setKey(to), { ...toSet, born: pTo.createdAt } satisfies PasskeySetValue);
    }
    // 2. Point the reverse entries at `to` (an absent one is re-claimed only on a first run: on a resume it may be a
    //    remove at `to` half done).
    await Promise.all(
      ids.flatMap((id) => {
        const v = named.get(id);
        return v === from ? [db.replaceIf(revKey(id), from, to)] : v === null && !resumed ? [db.setNx(revKey(id), to)] : [];
      }),
    );
    // 3. Only now: the entries of `from` that `to` does not list, then the `from` set and `pkreg:`.
    await endFrom(leftover.filter((id) => named.get(id) === from).map(revKey));
    return "moved";
  };
  if (opts.personLocked) return move();
  const [a, b] = from < to ? [from, to] : [to, from];
  return withPersonLock(a, () => withPersonLock(b, move));
}

/**
 * The sign-in lookup (rule 2405, pre-flight ruling 3): the reverse entry under `hash` names a pid, which must be a person
 * whose address signs in as that same pid (`getLogin(person.email).pid`), whose set carries the person's birth and holds
 * the credential. Null otherwise (an orphaned or stale entry grants nothing). The routes call this; only here is the
 * stored value turned into a person id.
 */
export async function resolvePasskeyLogin(hash: string): Promise<{ pid: PersonId; born: string; login: Login; set: PasskeySetValue; cred: PasskeyCredValue } | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const v = await db.get<unknown>(globalKey.passkeyCred(hash));
  if (typeof v !== "string" || !v) return null;
  const pid = storedPersonId(v);
  const person = await getPerson(pid);
  if (!person) return null;
  const [login, set] = await Promise.all([getLogin(person.email), readSet(pid, person.createdAt)]);
  if (!login || login.pid !== pid || !set) return null;
  const cred = set.creds.find((c) => credHash(c.id) === hash);
  return cred ? { pid, born: person.createdAt, login, set, cred } : null;
}
