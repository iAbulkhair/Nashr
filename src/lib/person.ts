import { db } from "./db";
import { log } from "./log";
import { withNamedLock } from "./locks";
import { normalizeEmail, type User } from "./auth";
import { accountKey, personKey, type PersonId } from "./keys";
import { parseStored, PersonRow, type PersonRowValue } from "./stored";
import { ownerOf } from "./membership";
import { memberPid, type Member } from "./team";
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
 *     from it, even when the legacy record lacks it (an owner: email, name, lang, passHash, emailVerifiedAt,
 *     sessionsAfter, devicesAfter, createdAt; a member the same without emailVerifiedAt); only the person-only fields
 *     (`suspended`, `trialUsedAt`, and for a member `emailVerifiedAt`) stay from the row. The `PersonRow` defaults
 *     (`name` "", `lang` "ar", `createdAt` "") filled in for a field the legacy record lacks never replace a real value.
 * Either way the mismatch is logged as `person stale` (shape only, no values). Every M1 credential write mirrors both
 * records, so in steady state they never differ.
 *
 * Read-only in this module apart from the lock; the writers come with the credential task (`updatePerson`).
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
  const legacy = fromOwner(pid, rawUser) ?? fromMember(pid, rawMember);
  const row = parseStored("person", PersonRow, rawPerson, null);
  if (row) {
    // The key wins over a stored `pid` that differs (as `getAccount` does for an account id).
    if (row.pid !== pid) log.warn("person id differs from its key", { shape: "person.pid" });
    if (legacy && newer(legacy.row.createdAt, row.createdAt)) {
      // Born after the row: a leftover, maybe another human's. It lends nothing but a set suspension (fail closed).
      log.warn("person stale", { shape: "person", source: legacy.source });
      return { ...legacy.row, ...keptSuspension(row), pid, source: legacy.source };
    }
    if (legacy && newer(legacy.row.sessionsAfter, row.sessionsAfter)) {
      // The same human, changed by a rolled-back build: the legacy record's own fields, the row's person-only ones.
      log.warn("person stale", { shape: "person", source: legacy.source });
      return { ...legacyOver(row, legacy), pid, source: legacy.source };
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
