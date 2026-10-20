import { db } from "./db";
import { log } from "./log";
import { withNamedLock } from "./locks";
import { getUser, normalizeEmail, saveUser, type User } from "./auth";
import { accountKey, personKey, storedAccountId, type AccountId, type PersonId } from "./keys";
import { parseStored, PersonRow, type PersonRowValue } from "./stored";
import { listOrgs, ownerOf } from "./membership";
import { pmap } from "./parallel";
import { memberPid, saveMember, withMemberLock, type Member } from "./team";
import { keptSuspension } from "./suspension";

/**
 * Persons (multi-workspace membership, docs/specs/2026-10-18-multi-org.md section 2, release M1 expand, rule 2134).
 *
 * A person is the human who signs in: credentials, the sign-in address, name, language, session stamps. It holds no
 * plan, credits or data (those are the ACCOUNT's, `user:{aid}`). Three records can hold a person, read in one round:
 *   1. `person:{pid}` (`PersonRow`), written from M1 by every credential write;
 *   2. else the legacy owner record `user:{pid}`, when `ownerOf` names `pid` (credential fields only: `suspended`, the
 *      plan and the rest stay ACCOUNT fields);
 *   3. else the legacy member record `member:{pid}`, when `memberPid` is `pid`.
 *
 * Stale guard (plan reconciliations 5 and 6): a rollback to a pre-M1 build writes only the legacy record, so on
 * roll-forward the `person:` copy can be out of date. The legacy record wins when it is provably newer, in two cases:
 *   - by birth (owner `createdAt` / member `acceptedAt` later than the person's `createdAt`): the legacy record was
 *     created after the person row, so the row is a leftover of an account deleted under a rolled-back build, possibly
 *     a different human. It lends nothing (reconciliation 6): the legacy record is read ALONE, except that a set
 *     `suspended` on the row is kept (fail closed: a leftover never lifts a suspension, it can only keep one);
 *   - by `sessionsAfter` (the legacy stamp later than the person's): the same human, changed by a rolled-back build (a
 *     new password, a new address with its verification cleared). EVERY field the legacy record type carries is read
 *     from it, even when the legacy record lacks it (an owner: email, name, lang, passHash, emailVerifiedAt, createdAt;
 *     a member the same without emailVerifiedAt); only the person-only fields (`suspended`, `trialUsedAt`, and for a
 *     member `emailVerifiedAt`) stay from the row. The two revocation stamps, `sessionsAfter` and `devicesAfter`, keep
 *     the LATER of both records (a missing or older legacy stamp never un-revokes a session or a device). The
 *     `PersonRow` defaults (`name` "", `lang` "ar", `createdAt` "") filled in for a field the legacy record lacks never
 *     replace a real value.
 * Either way the mismatch is logged as `person stale` (shape only, no values). Every M1 credential write mirrors both
 * records, so in steady state they never differ.
 *
 * Writers (rule 2132, credential part): `updatePerson` for every change of a password, name, language, revocation stamp
 * or address proof, and `createPersonRecord` for a new login. Both set `createdAt`; `updatePerson` mirrors the legacy
 * record (see there), so a build rolled back to R1 reads the same credentials and the stale guard never fires.
 */

/** A person as read: the stored row's fields, the id it was read under, and which record it came from. */
export type Person = PersonRowValue & { pid: PersonId; source: "person" | "owner" | "member" };

/** The person fields each legacy record type carries (the rest are person-only: `suspended`, `trialUsedAt`). */
const OWNER_FIELDS = ["email", "name", "lang", "passHash", "emailVerifiedAt", "sessionsAfter", "devicesAfter", "createdAt"] as const;
const MEMBER_FIELDS = ["email", "name", "lang", "passHash", "sessionsAfter", "devicesAfter", "createdAt"] as const;
type LegacyField = (typeof OWNER_FIELDS)[number];
/** Fields `PersonRow` fills with a default (`.catch`) when the record lacks them or holds an invalid value. */
const DEFAULTED: ReadonlySet<LegacyField> = new Set(["name", "lang", "createdAt"]);

/** A legacy record read as a person: the parsed row, the values as given before parsing, and the fields its type carries. */
type Legacy = { row: PersonRowValue; given: Partial<Record<LegacyField, unknown>>; fields: readonly LegacyField[]; source: "owner" | "member" };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The object without its `undefined` fields, so an absent legacy field never hides a person's value (and a field a form did not send is never written). */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const time = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);
/** `legacy` is a valid moment later than `current` (an absent or malformed `current` counts as never). */
const newer = (legacy: unknown, current: unknown): boolean => {
  const l = time(legacy);
  if (!Number.isFinite(l)) return false;
  const c = time(current);
  return !Number.isFinite(c) || l > c;
};
/** The later of two stamps; a malformed one never wins over a valid one. */
const later = (a: string | undefined, b: string | undefined): string | undefined => (newer(b, a) ? b : a ?? b);
/** The revocation stamps a session is checked against (`resolveSession`). */
const STAMPS = ["sessionsAfter", "devicesAfter"] as const;
/**
 * Each revocation stamp as the latest of the given records (absent ones skipped): a stamp never moves backwards, so a
 * "sign out" written by any build, to either record, keeps its effect (multi-workspace M1, 2026-10-19, rule 2132).
 */
const latestStamps = (...recs: (Partial<Record<(typeof STAMPS)[number], unknown>> | null | undefined)[]): { sessionsAfter?: string; devicesAfter?: string } =>
  defined(Object.fromEntries(STAMPS.map((k) => [k, recs.reduce<string | undefined>((acc, r) => later(acc, typeof r?.[k] === "string" ? (r[k] as string) : undefined), undefined)])));

/** Step 2: the legacy owner record at `user:{pid}`, only when the account's owner IS this person. */
function fromOwner(pid: PersonId, raw: unknown): Legacy | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const u = raw as Partial<User> & { email: string };
  // The key a record is read from is its id (`getAccount`): a stored id that differs is ignored. An `ownerPid` naming
  // someone else means this account's owner is another person, and its credential fields belong to nobody.
  if (ownerOf({ ownerPid: u.ownerPid, id: u.id === undefined ? undefined : pid, email: u.email }) !== pid) return null;
  const given = defined({
    email: normalizeEmail(u.email),
    name: u.name,
    lang: u.lang,
    passHash: u.passHash,
    emailVerifiedAt: u.emailVerifiedAt,
    sessionsAfter: u.sessionsAfter,
    devicesAfter: u.devicesAfter,
    createdAt: u.createdAt,
  });
  const row = parseStored("person.owner", PersonRow, { pid, ...given }, null);
  return row ? { row, given, fields: OWNER_FIELDS, source: "owner" } : null;
}

/** Step 3: the legacy member record at `member:{pid}`, only when its person id is `pid` (`memberPid`). */
function fromMember(pid: PersonId, raw: unknown): Legacy | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const m = raw as Partial<Member> & { email: string };
  if (memberPid({ id: m.id, email: m.email }) !== pid) return null;
  const given = defined({
    email: normalizeEmail(m.email),
    name: m.name,
    lang: m.lang,
    passHash: m.passHash,
    sessionsAfter: m.sessionsAfter,
    devicesAfter: m.devicesAfter,
    createdAt: m.acceptedAt,
  });
  const row = parseStored("person.member", PersonRow, { pid, ...given }, null);
  return row ? { row, given, fields: MEMBER_FIELDS, source: "member" } : null;
}

/**
 * The row with every field the legacy record's type carries replaced by the legacy value, removed when the legacy
 * record lacks it, except a defaulted field (`DEFAULTED`) whose legacy value is absent or was replaced by its default:
 * that keeps the row's real value. Person-only fields and unknown stored keys stay from the row.
 */
function legacyOver(row: PersonRowValue, legacy: Legacy): PersonRowValue {
  const taken: readonly string[] = legacy.fields.filter((f) => !(DEFAULTED.has(f) && legacy.given[f] !== legacy.row[f]));
  const kept = Object.fromEntries(Object.entries(row).filter(([k]) => !taken.includes(k)));
  return { ...kept, ...defined(Object.fromEntries(taken.map((f) => [f, legacy.row[f as LegacyField]]))) } as PersonRowValue;
}

/**
 * The precedence of `getPerson`, pure, over the three raw values read from `person:{pid}`, `user:{pid}` and
 * `member:{pid}`, so a caller that reads them inside its own round (`resolveSession`) gets the same answer. Null when
 * none of the three is this person's.
 */
export function personFromRaw(pid: PersonId, rawPerson: unknown, rawUser: unknown, rawMember: unknown): Person | null {
  return resolvePerson(pid, rawPerson, rawUser, rawMember)?.person ?? null;
}

/** `personFromRaw`, plus the legacy record that backs the person (the one `updatePerson` mirrors to), or null. */
function resolvePerson(pid: PersonId, rawPerson: unknown, rawUser: unknown, rawMember: unknown): { person: Person; legacy: Legacy | null } | null {
  const legacy = fromOwner(pid, rawUser) ?? fromMember(pid, rawMember);
  const row = parseStored("person", PersonRow, rawPerson, null);
  if (row) {
    // The key wins over a stored `pid` that differs (as `getAccount` does for an account id).
    if (row.pid !== pid) log.warn("person id differs from its key", { shape: "person.pid" });
    if (legacy && newer(legacy.row.createdAt, row.createdAt)) {
      // Born after the row: a leftover, maybe another human's. It lends nothing but a set suspension (fail closed).
      log.warn("person stale", { shape: "person", source: legacy.source });
      return { person: { ...legacy.row, ...keptSuspension(row), pid, source: legacy.source }, legacy };
    }
    if (legacy && newer(legacy.row.sessionsAfter, row.sessionsAfter)) {
      // The same human, changed by a rolled-back build: the legacy record's own fields, the row's person-only ones.
      // The two revocation stamps keep the later of both records: a missing or older legacy stamp never un-revokes.
      log.warn("person stale", { shape: "person", source: legacy.source });
      const merged = legacyOver(row, legacy);
      const stamps = defined({ sessionsAfter: later(row.sessionsAfter, legacy.row.sessionsAfter), devicesAfter: later(row.devicesAfter, legacy.row.devicesAfter) });
      return { person: { ...merged, ...stamps, pid, source: legacy.source }, legacy };
    }
    // The row wins, but a revocation stamp keeps the later of both records: R1's "sign out other devices" moves only the
    // legacy `devicesAfter` (rule 1170), and a rolled-back build's sign-out must still end those sessions.
    return { person: { ...row, ...latestStamps(row, legacy?.row), pid, source: "person" }, legacy };
  }
  return legacy ? { person: { ...legacy.row, pid, source: legacy.source }, legacy } : null;
}

/** The one reader of a person (rule 2134): `person:{pid}`, `user:{pid}` and `member:{pid}` in ONE round. */
export async function getPerson(pid: PersonId): Promise<Person | null> {
  const [p, u, m] = await Promise.all([db.get(personKey.person(pid)), db.get(accountKey.user(pid)), db.get(accountKey.member(pid))]);
  return personFromRaw(pid, p, u, m);
}

/**
 * Run `fn` under `lock:person:{pid}` (about 3 s wait, always released). Lock order (rule 2139): `inviteuse` →
 * `lock:team` → `lock:login` → `lock:person` → `lock:member` → `lock:user`. Not reentrant.
 */
export const withPersonLock = <T,>(pid: PersonId, fn: () => Promise<T>): Promise<T> => withNamedLock(personKey.lock(pid), fn, PERSON_LOCK_TIMEOUT);

/** What `withPersonLock` throws when the lock stays taken; routes answer it 409 `busy` (nothing was written). */
export const PERSON_LOCK_TIMEOUT = "person_lock_timeout";
export const isPersonLockTimeout = (e: unknown): boolean => e instanceof Error && e.message === PERSON_LOCK_TIMEOUT;

/** The credential and profile fields a write may change (`updatePerson`). */
export type PersonPatch = Partial<Pick<PersonRowValue, "name" | "lang" | "passHash" | "sessionsAfter" | "devicesAfter" | "emailVerifiedAt" | "trialUsedAt">>;

const valid = (v: unknown): v is string => Number.isFinite(time(v));

/** `fn` on the account `aid` under its user lock, or without it when the caller holds that lock (`held`). A gone account is skipped. */
async function onAccount(aid: AccountId, held: AccountId | undefined, fn: (x: User) => Promise<void>): Promise<void> {
  if (aid === held) {
    const x = await getUser(aid);
    if (x) await fn(x);
    return;
  }
  const { withUserLock } = await import("./credits");
  try {
    await withUserLock(aid, fn);
  } catch (e) {
    if (!(e instanceof Error && e.message === "user_not_found")) throw e;
  }
}

/**
 * The legacy record the person came from gets the row's values for every person field its type carries (never the
 * address or the birth date, which no credential write moves), so an R1 build reads the same credentials and the stale
 * guard sees two records that agree. Only defined values are written: a mirror never deletes a field, and never moves a
 * proof date the legacy record already holds. Owner: under
 * `lock:user:{pid}` (or the caller's hold of it), only while `ownerOf` still names this person. Member: under
 * `lock:member`, only while the record's person id is this one.
 */
async function mirror(pid: PersonId, legacy: Legacy, row: PersonRowValue, held: AccountId | undefined): Promise<void> {
  const values = defined(Object.fromEntries(legacy.fields.filter((f) => f !== "email" && f !== "createdAt").map((f) => [f, row[f]])));
  if (legacy.source === "owner") {
    await onAccount(storedAccountId(pid), held, async (x) => {
      if (ownerOf(x) !== pid) return;
      // A proof date already on the account is never moved (as `markVerified` and the reset keep the first date), and a
      // revocation stamp on the record as it is NOW never moves backwards.
      await saveUser(Object.assign(x, values, latestStamps(values, x), x.emailVerifiedAt ? { emailVerifiedAt: x.emailVerifiedAt } : {}));
    });
    return;
  }
  await withMemberLock(pid, async (m) => {
    if (memberPid(m) !== pid) return;
    await saveMember(Object.assign(m, values, latestStamps(values, m)));
  });
}

/**
 * Reconciliation 11: a proved address is the person's, and every account the person owns reads it (`emailVerified`
 * of the account gates sign-in for its owner and members, rule 751). Each account is stamped under its own user lock
 * (after the person lock, rule 2139), only when unset, so a repeat never moves the date. The legacy home of a legacy
 * owner was already written by the mirror.
 */
async function stampOwned(pid: PersonId, stamp: string, mirrored: boolean, held: AccountId | undefined): Promise<void> {
  const owned = (await listOrgs(pid)).filter((o) => o.role === "owner" && !(mirrored && o.aid === storedAccountId(pid)));
  await pmap(owned, async ({ aid }) =>
    onAccount(aid, held, async (x) => {
      if (ownerOf(x) !== pid || x.emailVerifiedAt) return;
      x.emailVerifiedAt = stamp;
      await saveUser(x);
    }),
  );
}

/**
 * The one writer of a person's credentials (rule 2132, credential part). Under `lock:person:{pid}` (unless the caller
 * holds it, `personLocked`): read the person as `getPerson` does, write `person:{pid}` as that view plus `patch` (unknown
 * stored fields kept), and mirror the person fields to the legacy record that backs the person, FIRST: a legacy lock
 * that cannot be had throws before anything is written, and a person write that fails after it leaves the legacy
 * record newer, which the stale guard reads. `createdAt` is the legacy birth when a legacy record backs the person
 * (an owner's `createdAt`, a member's `acceptedAt`), so the birth guard never fires on a mirrored row.
 *
 * `emailVerifiedAt` only fills an absent stamp (a repeat never moves the date) and also stamps every account the person
 * owns (`stampOwned`). `userLocked` names an account whose `lock:user` the caller holds and whose record it saved before
 * this call: that record is read and written here without its lock (locks are not reentrant).
 *
 * Null, with nothing written, when no record holds the person.
 */
export async function updatePerson(pid: PersonId, patch: PersonPatch, opts: { personLocked?: boolean; userLocked?: AccountId } = {}): Promise<Person | null> {
  const run = async (): Promise<Person | null> => {
    const [p, u, m] = await Promise.all([db.get(personKey.person(pid)), db.get(accountKey.user(pid)), db.get(accountKey.member(pid))]);
    const read = resolvePerson(pid, p, u, m);
    if (!read) return null;
    const { person, legacy } = read;
    const { pid: _pid, source: _source, ...view } = person;
    void _pid; void _source;
    const changes: PersonPatch = defined(patch);
    if (changes.emailVerifiedAt && view.emailVerifiedAt) delete changes.emailVerifiedAt;
    const birth = legacy && valid(legacy.row.createdAt) ? legacy.row.createdAt : valid(view.createdAt) ? view.createdAt : new Date().toISOString();
    // A revocation stamp is the latest of the row, the legacy record and the patch: a write never un-revokes a session.
    const row = { ...view, ...changes, ...latestStamps(view, legacy?.row, changes), pid, createdAt: birth } as PersonRowValue;
    if (legacy) await mirror(pid, legacy, row, opts.userLocked);
    await db.set(personKey.person(pid), row);
    if (patch.emailVerifiedAt && row.emailVerifiedAt) await stampOwned(pid, row.emailVerifiedAt, legacy?.source === "owner", opts.userLocked);
    return { ...row, pid, source: "person" };
  };
  return opts.personLocked ? run() : withPersonLock(pid, run);
}

/**
 * A new login's person row (plan reconciliation 6): `SET person:{pid}` whole, so a leftover row of a deleted account at
 * the same id (an address registered again) lends it nothing. The caller holds `lock:login` of the address and has
 * checked it is free. The write runs under `lock:person:{pid}` (`lock:login` → `lock:person`, rule 2139), so an
 * `updatePerson` that read the leftover row can never write it back over the new one; a held lock throws
 * `person_lock_timeout` before anything is written.
 *
 * - `personLocked`: the caller already holds `lock:person:{pid}` (`createUser` takes it before its first write, so a
 *   timeout leaves no account without its person).
 * - `userLockHeld`: the caller holds a `lock:user` (the address move, `moveOwnerLogin`), which comes AFTER `lock:person`
 *   in the order, so taking the person lock here would invert it. No lock is taken: the address is still unclaimed
 *   (`claimLogin` runs after this write, under the same login lock), so no session, reset link or route can resolve
 *   this person and no `updatePerson` of it can be running.
 */
export async function createPersonRecord(
  input: { pid: PersonId; email: string; name: string; lang: "ar" | "en"; passHash?: string; createdAt: string; sessionsAfter: string; devicesAfter?: string; emailVerifiedAt?: string },
  opts: { loginLocked: true; personLocked?: true; userLockHeld?: true },
): Promise<void> {
  const write = async () => { await db.set(personKey.person(input.pid), defined({ ...input, email: normalizeEmail(input.email) })); };
  if (opts.personLocked || opts.userLockHeld) return write();
  return withPersonLock(input.pid, write);
}

/** The later of two revocation stamps (a malformed one never wins over a valid one). */
export const laterStamp = later;
