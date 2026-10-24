// Script S1 of multi-workspace membership (docs/specs/2026-10-18-multi-org.md, table "Script S1" and rule 2133;
// docs/system/flows.md section 93.1): fills the M1 records for every login from before release M1. Run from
// `scripts/multi-org-index.ts` (a terminal) or, as a dry run only, from the founder console (POST
// /api/admin/conversions/multi-org-index, rule 4100), never at build time. M1 already writes these records for every new
// signup, invite and move, and reads the legacy records as a fallback, so nothing needs them yet: a run that stops
// halfway is harmless and the next run finishes it.
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the owner: `person:{pid}` copied from the legacy owner record if absent (`createPersonRecord`), `orgs:{pid}`
//     naming the account, and `login:{address}` naming the person if absent. An account that names its owner in
//     `ownerPid` already has its person: only `orgs:` and the index are filled;
//   - every member on its roster: `person:{pid}` from the legacy `member:` record if absent, `mbr:{aid}:{pid}` from the
//     same record if absent (`writeMembership`, which also fills `orgs:{pid}`; a paused member stays paused, since the
//     row carries the record's own `disabled`), and `login:{address}` if absent.
// Every write runs under the locks M1's own writers take (rule 2139: `lock:team` → `lock:login` → `lock:person` →
// `lock:member`) and reads the records again under them first; only what is still absent is written.
// It never overwrites: a `person:` row that is unreadable or whose hash or address differs from the legacy record, a
// `login:` index that names someone else, an owner record it cannot read as a person, a member record whose `memberOf`
// account is missing, and a roster entry without a record are counted and left as they are. A second run writes nothing
// (idempotent). The report is counts only: no email, id or key.
import { db, mgetChunked } from "../db";
import { pmap } from "../parallel";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "../keys";
import { LoginIndex } from "../account-id";
import { claimLogin, normalizeEmail, type User } from "../auth";
import { membershipFromRaw } from "../membership";
import { createPersonRecord, personFromRaw, withPersonLock, type Person } from "../person";
import { PersonRow, type MembershipValue } from "../stored";
import { withAccountTeamLock, withLoginLock, writeMembership } from "../team";

export type IndexReport = {
  apply: boolean;
  accounts: number;
  /** In `users:all` with no record (a deletion that stopped halfway): left alone. */
  missing: number;
  owners: number;
  members: number;
  /** Records written (or, in a dry run, that would be). */
  personsSet: number;
  membershipsSet: number;
  orgsSet: number;
  loginsSet: number;
  /** Memberships paused for seats: kept paused (the row copies the legacy `disabled`). */
  paused: number;
  /** A `person:` row that is unreadable, or whose hash or address differs from the legacy record. Never overwritten. */
  personConflicts: number;
  /** A `login:` index that names someone else (or is unreadable). Never overwritten. */
  loginConflicts: number;
  /** An owner record that cannot be read as a person, or an `ownerPid` with no `person:` row. */
  ownerConflicts: number;
  /** A member record on the roster whose `memberOf` account is missing. */
  orphanRecords: number;
  /** A roster entry with no record that backs it (no `mbr:` row, no home `member:` record, or no person at all). */
  orphanEntries: number;
  /** A lock that stayed held, or a record that changed between the read and the write: run again. */
  busy: number;
};

const CHUNK = 50;
type Fail = "person" | "login" | "owner" | "orphanRecord" | "orphanEntry" | "busy";
type Counter = Exclude<keyof IndexReport, "apply">;
const FAIL_FIELD: Record<Fail, Counter> = {
  person: "personConflicts",
  login: "loginConflicts",
  owner: "ownerConflicts",
  orphanRecord: "orphanRecords",
  orphanEntry: "orphanEntries",
  busy: "busy",
};

/** One person in one account: the owner (legacy when the account has no `ownerPid`) or a roster entry. */
type Subject = { kind: "owner"; aid: AccountId; pid: PersonId; legacy: boolean; login: string } | { kind: "member"; aid: AccountId; pid: PersonId; login: string };
/** The raw records one decision is made from, read in bulk (dry run) or again under the locks (apply). */
type Raw = { person: unknown; login: unknown; inOrgs: boolean; user?: unknown; member?: unknown; mbr?: unknown; listed?: boolean; memberOfMissing?: boolean };
type Verdict = { ok: false; why: Fail } | { ok: true; login: string; person: Person | null; row: MembershipValue | null; orgs: boolean; claim: boolean; paused: boolean };

const readIndex = (raw: unknown) => {
  if (raw === null || raw === undefined) return null;
  const r = LoginIndex.safeParse(raw);
  return r.success ? r.data : ("invalid" as const);
};
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The account a legacy member record names, when the record is this roster entry's own person but of another account. */
const otherTeam = (s: Subject, raw: unknown): string | null =>
  s.kind === "member" && isRecord(raw) && typeof raw.memberOf === "string" && raw.memberOf !== s.aid && typeof raw.email === "string" && normalizeEmail(raw.email) === s.pid ? raw.memberOf : null;

/** Pure: what S1 writes for one subject, or why it writes nothing. Used for the dry-run counts and again under the locks. */
function decide(s: Subject, r: Raw): Verdict {
  const fail = (why: Fail): Verdict => ({ ok: false, why });
  const parsed = r.person === null || r.person === undefined ? null : PersonRow.safeParse(r.person);
  if (parsed && !parsed.success) return fail("person");
  const cur = parsed ? parsed.data : null;
  let legacy: Person | null = null;
  let row: MembershipValue | null = null;
  let paused = false;
  if (s.kind === "owner") {
    if (s.legacy) {
      legacy = personFromRaw(s.pid, null, r.user, null);
      if (!legacy) return fail("owner");
    } else if (!cur) return fail("owner"); // the person holds the credentials; S1 has nothing to copy them from
  } else {
    if (!r.listed) return { ok: true, login: s.login, person: null, row: null, orgs: false, claim: false, paused: false }; // removed meanwhile
    const home = membershipFromRaw(s.aid, s.pid, null, r.member, true);
    const own = membershipFromRaw(s.aid, s.pid, r.mbr, null, true);
    if (!home && !own) return fail(r.memberOfMissing ? "orphanRecord" : "orphanEntry");
    if (home) {
      legacy = personFromRaw(s.pid, null, null, r.member);
      if (!legacy) return fail("orphanEntry");
    }
    if (!own && home) row = { aid: home.aid, pid: home.pid, role: home.role, acceptedAt: home.acceptedAt, invitedBy: home.invitedBy, ...(home.disabled ? { disabled: home.disabled } : {}) };
    paused = !!(own ?? home)?.disabled;
  }
  if (cur && legacy && ((cur.passHash && legacy.passHash && cur.passHash !== legacy.passHash) || normalizeEmail(cur.email) !== normalizeEmail(legacy.email))) return fail("person");
  const who = legacy ?? cur;
  if (!who) return fail("orphanEntry");
  const login = normalizeEmail(who.email);
  if (s.login && login !== s.login) return fail("busy"); // the address changed since the bulk read
  const idx = readIndex(r.login);
  if (idx === "invalid" || (idx !== null && idx.pid !== s.pid)) return fail("login");
  return { ok: true, login, person: cur ? null : legacy, row, orgs: !r.inOrgs, claim: idx === null, paused };
}
/** `mgetChunked` over the keys that are given, aligned with the input: null where no key was. */
async function mgetSome(keys: readonly (string | null)[]): Promise<unknown[]> {
  const given = keys.filter((k): k is string => k !== null);
  const values = await mgetChunked<unknown>(given);
  let at = 0;
  return keys.map((k) => (k === null ? null : values[at++]));
}
const writes = (v: Verdict) => v.ok && (!!v.person || !!v.row || v.orgs || v.claim);

/** The person row S1 writes: the legacy record's own fields, as `personFromRaw` read them. */
const personInput = (p: Person) => ({
  pid: p.pid,
  email: p.email,
  name: p.name,
  lang: p.lang,
  passHash: p.passHash,
  createdAt: p.createdAt,
  sessionsAfter: p.sessionsAfter,
  devicesAfter: p.devicesAfter,
  emailVerifiedAt: p.emailVerifiedAt,
});

/** One subject's records, read again in ONE round under its locks (plus the `memberOf` account when the record names another). */
async function readOne(s: Subject): Promise<Raw> {
  const [person, login, inOrgs, user, member, mbr, listed] = await Promise.all([
    db.get(personKey.person(s.pid)),
    db.get(accountKey.login(s.login)),
    db.sismember(personKey.orgs(s.pid), s.aid),
    s.kind === "owner" ? db.get(accountKey.user(s.aid)) : null,
    s.kind === "member" ? db.get(accountKey.member(s.pid)) : null,
    s.kind === "member" ? db.get(accountKey.membership(s.aid, s.pid)) : null,
    s.kind === "member" ? db.sismember(accountKey.members(s.aid), s.pid) : false,
  ]);
  const other = otherTeam(s, member);
  const memberOfMissing = other !== null && (await db.get(accountKey.user(other))) === null;
  return { person, login, inOrgs: !!inOrgs, user, member, mbr, listed: !!listed, memberOfMissing };
}

/** Write what is still absent for one subject, under `lock:team` (members) → `lock:login` → `lock:person`. */
async function applyOne(s: Subject): Promise<Verdict> {
  const locked = () =>
    withLoginLock(s.login, () =>
      withPersonLock(s.pid, async () => {
        const v = decide(s, await readOne(s));
        if (!v.ok) return v;
        await Promise.all([
          v.person ? createPersonRecord(personInput(v.person), { loginLocked: true, personLocked: true }) : null,
          // `writeMembership` writes the row, the roster entry and `orgs:{pid}`; the legacy record already matches the row,
          // so it is left byte for byte as it is (`lock:member` taken inside, after `lock:person`, rule 2139).
          v.row ? writeMembership(s.aid, s.pid, v.row, { home: true, teamLocked: true }) : v.orgs ? db.sadd(personKey.orgs(s.pid), s.aid) : null,
          v.claim ? claimLogin(v.login, s.pid) : null,
        ]);
        return v;
      }),
    );
  // Only a lock that could not be had is "busy" (a second run finishes it); any other error stops the run (exit 2).
  return (s.kind === "member" ? withAccountTeamLock(s.aid, locked) : locked()).catch((e: unknown): Verdict => {
    if (e instanceof Error && /(^|_)lock_timeout$/.test(e.message)) return { ok: false, why: "busy" };
    throw e;
  });
}

export async function run(opts: { apply: boolean }): Promise<IndexReport> {
  const r: IndexReport = { apply: opts.apply, accounts: 0, missing: 0, owners: 0, members: 0, personsSet: 0, membershipsSet: 0, orgsSet: 0, loginsSet: 0, paused: 0, personConflicts: 0, loginConflicts: 0, ownerConflicts: 0, orphanRecords: 0, orphanEntries: 0, busy: 0 };
  const count = (v: Verdict) => {
    if (!v.ok) {
      r[FAIL_FIELD[v.why]]++;
      return;
    }
    if (v.person) r.personsSet++;
    if (v.row) r.membershipsSet++;
    if (v.orgs) r.orgsSet++;
    if (v.claim) r.loginsSet++;
  };

  // Round 1: the accounts and their rosters.
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const users = await mgetChunked<User>(ids.map((id) => accountKey.user(id)));
  const rosters = await pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK);
  const subjects: Subject[] = [];
  ids.forEach((id, i) => {
    const u = users[i];
    if (!u) {
      r.missing++;
      return;
    }
    const aid = storedAccountId(id);
    // A stored id that is not the key it is read from was written by hand or by a bug: reported, never indexed.
    if (!u.ownerPid && u.id !== undefined && u.id !== id) {
      r.ownerConflicts++;
    } else {
      subjects.push({ kind: "owner", aid, pid: storedPersonId(u.ownerPid ?? id), legacy: !u.ownerPid, login: "" });
      r.owners++;
    }
    rosters[i].forEach((entry) => subjects.push({ kind: "member", aid, pid: storedPersonId(entry), login: "" }));
  });
  r.members = subjects.length - r.owners;

  // Round 2: each subject's person, legacy member record, membership row and `orgs:` entry.
  const userAt = new Map(ids.map((id, i) => [id, users[i]] as const));
  const member = (s: Subject) => s.kind === "member";
  const [persons, memberRecs, rows, inOrgs] = await Promise.all([
    mgetChunked<unknown>(subjects.map((s) => personKey.person(s.pid))),
    mgetSome(subjects.map((s) => (member(s) ? accountKey.member(s.pid) : null))),
    mgetSome(subjects.map((s) => (member(s) ? accountKey.membership(s.aid, s.pid) : null))),
    pmap(subjects, (s) => db.sismember(personKey.orgs(s.pid), s.aid), CHUNK),
  ]);
  // Round 3: the login index of each subject's address, and the account each other-team member record names.
  const logins = subjects.map((s, i) => {
    const legacy = s.kind === "owner" ? (s.legacy ? personFromRaw(s.pid, null, userAt.get(s.aid), null) : null) : personFromRaw(s.pid, null, null, memberRecs[i]);
    const cur = PersonRow.safeParse(persons[i]);
    return normalizeEmail(legacy?.email ?? (cur.success ? cur.data.email : ""));
  });
  const others = subjects.map((s, i) => otherTeam(s, memberRecs[i]));
  const [indexes, otherUsers] = await Promise.all([
    mgetSome(logins.map((l) => (l ? accountKey.login(l) : null))),
    mgetSome(others.map((o) => (o === null ? null : accountKey.user(o)))),
  ]);

  const work: Subject[] = [];
  subjects.forEach((s, i) => {
    const raw: Raw = {
      person: persons[i],
      login: indexes[i],
      inOrgs: !!inOrgs[i],
      user: s.kind === "owner" ? userAt.get(s.aid) : undefined,
      member: s.kind === "member" ? memberRecs[i] : undefined,
      mbr: s.kind === "member" ? rows[i] : undefined,
      listed: true,
      memberOfMissing: others[i] !== null && otherUsers[i] === null,
    };
    const v = decide(s, raw);
    count(v);
    if (v.ok && v.paused) r.paused++;
    if (writes(v)) work.push({ ...s, login: logins[i] });
  });
  if (!opts.apply) return r;

  // Counted again from what the writes find under their locks: a record changed since the read above is not overwritten.
  r.personsSet = r.membershipsSet = r.orgsSet = r.loginsSet = 0;
  const outcomes = await pmap(work, applyOne, CHUNK);
  outcomes.forEach(count);
  return r;
}
