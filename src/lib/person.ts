import { db } from "./db";
import { log } from "./log";
import { withNamedLock } from "./locks";
import { getUser, normalizeEmail, saveUser, type User } from "./auth";
import { personKey, type AccountId, type PersonId } from "./keys";
import { parseStored, PersonRow, type PersonRowValue } from "./stored";
import { listOrgs, ownerOf } from "./membership";
import { pmap } from "./parallel";

/**
 * Persons (multi-workspace membership, docs/specs/2026-10-18-multi-org.md section 2; release M1 expand, rule 2134;
 * release M4 contract, rule 2138).
 *
 * A person is the human who signs in: credentials, the sign-in address, name, language, session stamps. It holds no
 * plan, credits or data (those are the ACCOUNT's, `user:{aid}`). From M4 one record holds a person: `person:{pid}`
 * (`PersonRow`). The legacy owner record `user:{pid}` and member record `member:{pid}` are no longer read for
 * credentials (M1 to M3 read them as a fallback, through a stale guard, and mirrored every credential write to them);
 * Script S2 (`scripts/multi-org-contract.ts`) removes the credential fields left on them.
 *
 * Writers (rule 2132, credential part): `updatePerson` for every change of a password, name, language, revocation stamp
 * or address proof, and `createPersonRecord` for a new login. Neither writes a legacy record.
 */

/** A person as read: the stored row's fields and the id it was read under. `source` is always `"person"` from M4. */
export type Person = PersonRowValue & { pid: PersonId; source: "person" };

/** The object without its `undefined` fields, so an absent field never hides a value (and a field a form did not send is never written). */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const time = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);
/** `b` is a valid moment later than `a` (an absent or malformed `a` counts as never). */
const newer = (b: unknown, a: unknown): boolean => {
  const l = time(b);
  if (!Number.isFinite(l)) return false;
  const c = time(a);
  return !Number.isFinite(c) || l > c;
};
/** The later of two stamps; a malformed one never wins over a valid one. */
const later = (a: string | undefined, b: string | undefined): string | undefined => (newer(b, a) ? b : a ?? b);
/** The revocation stamps a session is checked against (`resolveSession`). */
const STAMPS = ["sessionsAfter", "devicesAfter"] as const;
/** Each revocation stamp as the latest of the given records (absent ones skipped): a stamp never moves backwards. */
const latestStamps = (...recs: (Partial<Record<(typeof STAMPS)[number], unknown>> | null | undefined)[]): { sessionsAfter?: string; devicesAfter?: string } =>
  defined(Object.fromEntries(STAMPS.map((k) => [k, recs.reduce<string | undefined>((acc, r) => later(acc, typeof r?.[k] === "string" ? (r[k] as string) : undefined), undefined)])));

/**
 * The person stored at `person:{pid}`, pure over the raw value, so a caller that reads it inside its own round
 * (`resolveSession`) gets the same answer as `getPerson`. Null when the row is absent or fails `PersonRow` (logged
 * without values by `parseStored`). The key wins over a stored `pid` that differs (as `getAccount` does for an account).
 */
export function personFromRaw(pid: PersonId, rawPerson: unknown): Person | null {
  const row = parseStored("person", PersonRow, rawPerson, null);
  if (!row) return null;
  if (row.pid !== pid) log.warn("person id differs from its key", { shape: "person.pid" });
  return { ...row, pid, source: "person" };
}

/** The one reader of a person (rules 2134, 2138): `person:{pid}` only. */
export async function getPerson(pid: PersonId): Promise<Person | null> {
  return personFromRaw(pid, await db.get(personKey.person(pid)));
}

/**
 * Run `fn` under `lock:person:{pid}` (about 3 s wait, always released). Lock order (rule 2139): `inviteuse` →
 * `lock:team` → `lock:login` → `lock:person` → `lock:member` → `lock:user`. Not reentrant.
 */
export const withPersonLock = <T,>(pid: PersonId, fn: () => Promise<T>): Promise<T> => withNamedLock(personKey.lock(pid), fn, PERSON_LOCK_TIMEOUT);

/** What `withPersonLock` throws when the lock stays taken; routes answer it 409 `busy` (nothing was written). */
export const PERSON_LOCK_TIMEOUT = "person_lock_timeout";

/**
 * The address moves' person locks expire after 60 s, not 10 s (passkeys Task 6 fix round 1), the same as their
 * `lock:team` (`MOVE_TEAM_LOCK_TTL_SECONDS` in src/lib/team.ts): a move holds them across the user and team lock waits,
 * the carry, the passkey move and the old person's wipe, and the shared lock has no renewal. A held lock still throws
 * `person_lock_timeout` after the same wait; released as soon as the move ends.
 */
export const MOVE_PERSON_LOCK_TTL_SECONDS = 60;
export const withMovePersonLock = <T,>(pid: PersonId, fn: () => Promise<T>): Promise<T> =>
  withNamedLock(personKey.lock(pid), fn, PERSON_LOCK_TIMEOUT, MOVE_PERSON_LOCK_TTL_SECONDS);
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
 * Reconciliation 11: a proved address is the person's, and every account the person owns reads it (`emailVerified`
 * of the account gates sign-in for its owner and members, rule 751). Each account is stamped under its own user lock
 * (after the person lock, rule 2139), only when unset, so a repeat never moves the date. From M4 this covers a legacy
 * owner's own account too: no mirror writes it any more.
 */
async function stampOwned(pid: PersonId, stamp: string, held: AccountId | undefined): Promise<void> {
  const owned = (await listOrgs(pid)).filter((o) => o.role === "owner");
  await pmap(owned, async ({ aid }) =>
    onAccount(aid, held, async (x) => {
      if (ownerOf(x) !== pid || x.emailVerifiedAt) return;
      x.emailVerifiedAt = stamp;
      await saveUser(x);
    }),
  );
}

/**
 * The one writer of a person's credentials (rules 2132, 2138). Under `lock:person:{pid}` (unless the caller holds it,
 * `personLocked`): read `person:{pid}` and write it as that row plus `patch` (unknown stored fields kept). No legacy
 * record is written (M4 contract): `user:` and `member:` hold no credentials any more.
 *
 * `emailVerifiedAt` only fills an absent stamp (a repeat never moves the date) and also stamps every account the person
 * owns (`stampOwned`). `userLocked` names an account whose `lock:user` the caller holds and whose record it saved before
 * this call: that record is read and written here without its lock (locks are not reentrant).
 *
 * Null, with nothing written, when no `person:` row holds the person.
 */
export async function updatePerson(pid: PersonId, patch: PersonPatch, opts: { personLocked?: boolean; userLocked?: AccountId } = {}): Promise<Person | null> {
  const run = async (): Promise<Person | null> => {
    const person = await getPerson(pid);
    if (!person) return null;
    const { pid: _pid, source: _source, ...view } = person;
    void _pid; void _source;
    const changes: PersonPatch = defined(patch);
    if (changes.emailVerifiedAt && view.emailVerifiedAt) delete changes.emailVerifiedAt;
    const birth = valid(view.createdAt) ? view.createdAt : new Date().toISOString();
    // A revocation stamp is the later of the row and the patch: a write never un-revokes a session.
    const row = { ...view, ...changes, ...latestStamps(view, changes), pid, createdAt: birth } as PersonRowValue;
    await db.set(personKey.person(pid), row);
    if (patch.emailVerifiedAt && row.emailVerifiedAt) await stampOwned(pid, row.emailVerifiedAt, opts.userLocked);
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
 *   timeout leaves no account without its person; the owner address move, `moveOwnerLogin`, takes both person locks
 *   before `lock:user`, rule 2139, passkeys Task 6).
 * - `sessionsAfter` must be named by every caller: a new login stamps it with its creation time; script S1
 *   (scripts/multi-org-index.ts, rule 2133) copies a record from before M1 as it is, and passes `undefined` when that
 *   record has none (inventing a stamp there would sign the person out of every session).
 */
export async function createPersonRecord(
  input: { pid: PersonId; email: string; name: string; lang: "ar" | "en"; passHash?: string; createdAt: string; sessionsAfter: string | undefined; devicesAfter?: string; emailVerifiedAt?: string; trialUsedAt?: string },
  opts: { loginLocked: true; personLocked?: true; userLockHeld?: true },
): Promise<void> {
  const write = async () => { await db.set(personKey.person(input.pid), defined({ ...input, email: normalizeEmail(input.email) })); };
  if (opts.personLocked) return write();
  return withPersonLock(input.pid, write);
}

/** The later of two revocation stamps (a malformed one never wins over a valid one). */
export const laterStamp = later;
