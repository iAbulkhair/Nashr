import { db } from "./db";
import { log } from "./log";
import { withNamedLock } from "./locks";
import { normalizeEmail, type User } from "./auth";
import { accountKey, personKey, type PersonId } from "./keys";
import { parseStored, PersonRow, type PersonRowValue } from "./stored";
import { ownerOf } from "./membership";
import { memberPid, type Member } from "./team";

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
 * Stale guard (plan reconciliation 5): a rollback to a pre-M1 build that changes a password writes only the legacy
 * record, so on roll-forward the `person:` copy would carry the OLD hash. The legacy record therefore wins when it is
 * provably newer (its `sessionsAfter` later than the person's, or its birth, owner `createdAt` / member `acceptedAt`,
 * later than the person's `createdAt`): its fields are read over the person's, the session stamps keep the later of the
 * two (a later stamp only ends more sessions), and the mismatch is logged as `person stale` (shape only, no values).
 * Every M1 credential write mirrors both records, so in steady state they never differ.
 *
 * Read-only in this module apart from the lock; the writers come with the credential task (`updatePerson`).
 */

/** A person as read: the stored row's fields, the id it was read under, and which record it came from. */
export type Person = PersonRowValue & { pid: PersonId; source: "person" | "owner" | "member" };

type Legacy = { row: PersonRowValue; source: "owner" | "member" };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The object without its `undefined` fields, so an absent legacy field never hides a person's value. */
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
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

/** Step 2: the legacy owner record at `user:{pid}`, only when the account's owner IS this person. */
function fromOwner(pid: PersonId, raw: unknown): Legacy | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const u = raw as Partial<User> & { email: string };
  // The key a record is read from is its id (`getAccount`): a stored id that differs is ignored. An `ownerPid` naming
  // someone else means this account's owner is another person, and its credential fields belong to nobody.
  if (ownerOf({ ownerPid: u.ownerPid, id: u.id === undefined ? undefined : pid, email: u.email }) !== pid) return null;
  const row = parseStored("person.owner", PersonRow, defined({
    pid,
    email: normalizeEmail(u.email),
    name: u.name,
    lang: u.lang,
    passHash: u.passHash,
    emailVerifiedAt: u.emailVerifiedAt,
    sessionsAfter: u.sessionsAfter,
    devicesAfter: u.devicesAfter,
    createdAt: u.createdAt,
  }), null);
  return row ? { row, source: "owner" } : null;
}

/** Step 3: the legacy member record at `member:{pid}`, only when its person id is `pid` (`memberPid`). */
function fromMember(pid: PersonId, raw: unknown): Legacy | null {
  if (!isRecord(raw) || typeof raw.email !== "string") return null;
  const m = raw as Partial<Member> & { email: string };
  if (memberPid({ id: m.id, email: m.email }) !== pid) return null;
  const row = parseStored("person.member", PersonRow, defined({
    pid,
    email: normalizeEmail(m.email),
    name: m.name,
    lang: m.lang,
    passHash: m.passHash,
    sessionsAfter: m.sessionsAfter,
    devicesAfter: m.devicesAfter,
    createdAt: m.acceptedAt,
  }), null);
  return row ? { row, source: "member" } : null;
}

/**
 * The precedence of `getPerson`, pure, over the three raw values read from `person:{pid}`, `user:{pid}` and
 * `member:{pid}`, so a caller that reads them inside its own round (`resolveSession`) gets the same answer. Null when
 * none of the three is this person's.
 */
export function personFromRaw(pid: PersonId, rawPerson: unknown, rawUser: unknown, rawMember: unknown): Person | null {
  const legacy = fromOwner(pid, rawUser) ?? fromMember(pid, rawMember);
  const row = parseStored("person", PersonRow, rawPerson, null);
  if (row) {
    // The key wins over a stored `pid` that differs (as `getAccount` does for an account id).
    if (row.pid !== pid) log.warn("person id differs from its key", { shape: "person.pid" });
    if (legacy && (newer(legacy.row.sessionsAfter, row.sessionsAfter) || newer(legacy.row.createdAt, row.createdAt))) {
      log.warn("person stale", { shape: "person", source: legacy.source });
      return {
        ...row,
        ...defined(legacy.row),
        sessionsAfter: later(row.sessionsAfter, legacy.row.sessionsAfter),
        devicesAfter: later(row.devicesAfter, legacy.row.devicesAfter),
        pid,
        source: legacy.source,
      };
    }
    return { ...row, pid, source: "person" };
  }
  return legacy ? { ...legacy.row, pid, source: legacy.source } : null;
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
export const withPersonLock = <T,>(pid: PersonId, fn: () => Promise<T>): Promise<T> => withNamedLock(personKey.lock(pid), fn, "person_lock_timeout");
