// Script S2 of multi-workspace membership (docs/specs/2026-10-18-multi-org.md, "Releases"; rule 2138, listed in
// docs/system/tests/2110-multi-org.md; rules 2762-2764 in docs/system/tests/2760-multi-org-m4.md; docs/system/flows.md
// section 93.4): removes the legacy copies that release M4 no longer reads. Run by hand ONCE, after M4 is live and only
// on the founder's yes (it writes production data), never at build time and not as part of `npm run check`. M4 reads
// credentials only from `person:{pid}` and memberships only from `mbr:{aid}:{pid}` and the roster, so nothing this
// script removes is read by the build it runs under; a run that stops halfway is harmless and the next run finishes it.
// Never run it while a build before M4 serves traffic: M3 and earlier still read the legacy records as a fallback.
//
// Usage:  npx --no-install jiti scripts/multi-org-contract.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/multi-org-contract.ts --apply    (strip and delete)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the lock-out check (rule 2765), for the owner and for every roster entry, with or without credentials left: the
//     person's `person:` row exists and parses (`personMissing`), and the account is in the person's `orgs:{pid}`
//     (`notInOrgs`). M4 signs in, switches and resolves MCP tokens only through those two, so both counts must be 0 in
//     the dry run before `--apply` (the release precondition), and nothing is stripped or deleted for a subject with a gap;
//   - the account record loses `passHash`, `sessionsAfter` and `devicesAfter`, under `lock:user` and read again first,
//     only while its owner passes the lock-out check (the person holds the credentials from M4);
//   - every legacy `member:{login}` record named by a roster entry is deleted under `lock:team` → `lock:member` (rule
//     2139 order), read again first, when its twin `mbr:{memberOf}:{pid}` exists with the same account and person ids,
//     the roster of `memberOf` lists the person, and the person passes the lock-out check. From M4 the row is the truth
//     (src/lib/team.ts writes only the row), so a role, acceptedAt or pause that differs is counted for information
//     (`twinDiffers`) and never keeps the record. A record with no twin is counted (`twinMissing`) and kept. Records are
//     found through the rosters (Redis keys are not listed): a record no roster names is never reached, so never
//     deleted (a removal already deletes it, src/lib/team.ts `deleteMembership`);
//   - the legacy per-login link pointers (`sec:feedof:{login}`, `sec:bookof:{login}:{provider}`) are read to count the
//     calendar and booking links made before M1 (a record without `pid` and `aid`). They are adopted before M4 by the
//     M3 links script (rule 2756), so the count must be 0 (rule 2764): a link it counts is dead under M4. Nothing is
//     written for them.
// A second run strips and deletes nothing (idempotent). Re-run the dry run after any rollback to M3 and roll-forward:
// an M3 build writes the legacy copies again.
//
// Output is counts only: no email, id or key is printed.
// Exit codes: 0 done with nothing left over; 1 finished with a lock-out gap (`personMissing`, `notInOrgs`), a record
// kept (`twinMissing`), a link made before M1 (`preM1Links`) or a busy lock; 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "../src/lib/keys";
import { normalizeEmail } from "../src/lib/auth";
import { withUserLock } from "../src/lib/credits";
import { BOOK_KEYS, BOOK_PROVIDERS } from "../src/lib/booking-token";
import { FEED_KEYS, linkIds } from "../src/lib/feed-token";
import { MembershipRow, PersonRow } from "../src/lib/stored";
import { memberPid, withAccountTeamLock, withMemberLock, type Member } from "../src/lib/team";

export type ContractReport = {
  apply: boolean;
  accounts: number;
  /** In `users:all` with no record (a deletion that stopped halfway): left alone. */
  missing: number;
  /** An owner or roster entry whose `person:` row is missing or does not parse: nothing is stripped or deleted for it. */
  personMissing: number;
  /** An owner or roster entry whose account is not in its person's `orgs:{pid}`: nothing is stripped or deleted for it. */
  notInOrgs: number;
  /** Account records that still carry a credential field: stripped (or, in a dry run, that would be). */
  credsRemoved: number;
  /** Legacy `member:` records found through the rosters. */
  memberRecords: number;
  /** Legacy `member:` records whose twin exists: deleted (or would be). */
  membersDeleted: number;
  /** A legacy `member:` record with no `mbr:` twin of the same ids, or no roster entry: kept and reported. */
  twinMissing: number;
  /** Information only: a deleted record whose role, acceptedAt or pause differed from its twin (the row is the truth). */
  twinDiffers: number;
  /** A lock that stayed held, or a record that changed between the read and the write: run again. */
  busy: number;
  /** Calendar feed and booking links made before M1 (no `pid`/`aid` on the record): dead from M4, nothing written. */
  preM1Links: number;
};

const CHUNK = 50;
const CREDS = ["passHash", "sessionsAfter", "devicesAfter"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasCreds = (raw: unknown): boolean => isRecord(raw) && CREDS.some((k) => raw[k] !== undefined);
const personOk = (raw: unknown): boolean => raw !== null && raw !== undefined && PersonRow.safeParse(raw).success;
const isTimeout = (e: unknown) => e instanceof Error && /(^|_)lock_timeout$/.test(e.message);

/** The account record without the three credential fields, every other field byte for byte. */
function stripped(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!(CREDS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

type MemberVerdict = { v: "delete" | "missing" | "gap"; differs: boolean };
/**
 * Pure: whether a legacy member record may go. Its twin is the row of its own `memberOf` account and person id; the
 * person must pass the lock-out check (`gap` otherwise, already counted by the sweep). Differences in role, acceptedAt
 * or pause are reported, never a reason to keep it: from M4 only the row is written.
 */
function judgeMember(m: Member, row: unknown, listed: boolean, person: unknown, inOrgs: boolean): MemberVerdict {
  const r = row === null || row === undefined ? null : MembershipRow.safeParse(row);
  if (!r?.success || !listed || r.data.aid !== storedAccountId(m.memberOf) || r.data.pid !== storedPersonId(memberPid(m))) return { v: "missing", differs: false };
  if (!personOk(person) || !inOrgs) return { v: "gap", differs: false };
  const twin = r.data;
  const differs = twin.role !== m.role || twin.acceptedAt !== m.acceptedAt || (twin.disabled ?? null) !== (m.disabled ?? null);
  return { v: "delete", differs };
}
/** The keys a member record's verdict is read from: its twin row, the roster entry, the person row and its orgs set. */
const twinKeys = (m: Member) => {
  const aid = storedAccountId(m.memberOf);
  const pid = storedPersonId(memberPid(m));
  return { aid, pid, row: accountKey.membership(aid, pid), person: personKey.person(pid), orgs: personKey.orgs(pid) };
};

/** Strip one account record under `lock:user`, read again first (with the owner's lock-out check). */
async function stripOne(id: string, ownerPid: PersonId): Promise<"stripped" | "none" | "busy"> {
  return withUserLock(id, async () => {
    const [raw, person, inOrgs] = await Promise.all([db.get<unknown>(accountKey.user(id)), db.get<unknown>(personKey.person(ownerPid)), db.sismember(personKey.orgs(ownerPid), storedAccountId(id))]);
    if (!isRecord(raw) || !hasCreds(raw)) return "none" as const;
    // The owner named now may differ from the bulk read's (an ownership change meanwhile), or the owner lost the row or
    // the orgs entry since: nothing is stripped, and the next dry run reports it.
    if (storedPersonId(typeof raw.ownerPid === "string" ? raw.ownerPid : id) !== ownerPid) return "busy" as const;
    if (!personOk(person) || !inOrgs) return "busy" as const;
    await db.set(accountKey.user(id), stripped(raw));
    return "stripped" as const;
  }).catch((e: unknown) => {
    if (isTimeout(e)) return "busy" as const;
    if (e instanceof Error && e.message === "user_not_found") return "none" as const;
    throw e;
  });
}

/** Delete one legacy member record under `lock:team:{memberOf}` → `lock:member:{login}`, read again first. */
async function deleteOne(login: string, aid: AccountId): Promise<MemberVerdict | "gone" | "busy"> {
  return withAccountTeamLock(aid, async () => {
    const r = await withMemberLock(login, async (m): Promise<MemberVerdict | "busy"> => {
      if (storedAccountId(m.memberOf) !== aid) return "busy";
      const k = twinKeys(m);
      const [row, listed, person, inOrgs] = await Promise.all([db.get<unknown>(k.row), db.sismember(accountKey.members(k.aid), k.pid), db.get<unknown>(k.person), db.sismember(k.orgs, k.aid)]);
      const v = judgeMember(m, row, !!listed, person, !!inOrgs);
      if (v.v === "delete") await db.del(accountKey.member(login));
      return v;
    });
    return r ?? ("gone" as const);
  }).catch((e: unknown) => {
    if (isTimeout(e)) return "busy" as const;
    throw e;
  });
}

export async function run(opts: { apply: boolean }): Promise<ContractReport> {
  const r: ContractReport = { apply: opts.apply, accounts: 0, missing: 0, personMissing: 0, notInOrgs: 0, credsRemoved: 0, memberRecords: 0, membersDeleted: 0, twinMissing: 0, twinDiffers: 0, busy: 0, preM1Links: 0 };

  // Round 1: the accounts, their rosters and their owners' person rows.
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const [users, rosters] = await Promise.all([mgetChunked<unknown>(ids.map((id) => accountKey.user(id))), pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK)]);
  const owners = ids.map((id, i) => {
    const u = users[i];
    return isRecord(u) ? storedPersonId(typeof u.ownerPid === "string" ? u.ownerPid : id) : null;
  });
  r.missing = owners.filter((o) => o === null).length;

  // Round 2: the lock-out check of every owner and roster entry (person row, orgs entry), and every roster entry's
  // legacy member record (one per login, whatever the roster).
  const subjects = ids.flatMap((id, i) => {
    const aid = storedAccountId(id);
    const owner = owners[i];
    return [...(owner === null ? [] : [{ aid, pid: owner, owner: i }]), ...rosters[i].map((e) => ({ aid, pid: storedPersonId(e), owner: -1 }))];
  });
  const logins = [...new Set(rosters.flat().map((e) => normalizeEmail(e)))];
  const [subjectPersons, subjectOrgs, memberRecs] = await Promise.all([
    mgetChunked<unknown>(subjects.map((s) => personKey.person(s.pid))),
    pmap(subjects, (s) => db.sismember(personKey.orgs(s.pid), s.aid), CHUNK),
    mgetChunked<Member>(logins.map((l) => accountKey.member(l))),
  ]);
  const ownerOk = ids.map(() => false);
  subjects.forEach((s, i) => {
    const hasPerson = personOk(subjectPersons[i]);
    if (!hasPerson) r.personMissing++;
    if (!subjectOrgs[i]) r.notInOrgs++;
    if (s.owner >= 0) ownerOk[s.owner] = hasPerson && !!subjectOrgs[i];
  });
  const members = logins.flatMap((login, i) => {
    const m = memberRecs[i];
    return isRecord(m) && typeof m.memberOf === "string" ? [{ login, m }] : [];
  });
  r.memberRecords = members.length;

  // Round 3: each member record's twin, roster entry and person; the legacy link pointers of every address.
  const ownerLogins = ids.flatMap((_, i) => {
    const u = users[i];
    return isRecord(u) && typeof u.email === "string" ? [normalizeEmail(u.email)] : [];
  });
  const addresses = [...new Set([...ownerLogins, ...members.map((x) => x.login)])];
  const pointerKeys = addresses.flatMap((a) => [FEED_KEYS.of(a), ...BOOK_PROVIDERS.map((p) => BOOK_KEYS.of(a, p))]);
  const [rows, listed, persons, inOrgs, pointers] = await Promise.all([
    mgetChunked<unknown>(members.map(({ m }) => twinKeys(m).row)),
    pmap(members, ({ m }) => db.sismember(accountKey.members(twinKeys(m).aid), twinKeys(m).pid), CHUNK),
    mgetChunked<unknown>(members.map(({ m }) => twinKeys(m).person)),
    pmap(members, ({ m }) => db.sismember(twinKeys(m).orgs, twinKeys(m).aid), CHUNK),
    mgetChunked<unknown>(pointerKeys),
  ]);
  // Round 4: the link records the pointers name. A pointer is a record hash; the record's kind follows from the key.
  const linkKeys = pointerKeys.flatMap((k, i) => {
    const h = pointers[i];
    if (typeof h !== "string" || !h) return [];
    return [k.startsWith(FEED_KEYS.of("")) ? FEED_KEYS.rec(h) : BOOK_KEYS.rec(h)];
  });
  const links = await mgetChunked<unknown>([...new Set(linkKeys)]);
  r.preM1Links = links.filter((rec) => isRecord(rec) && linkIds(rec) === null).length;

  const strip: { id: string; owner: PersonId }[] = [];
  ids.forEach((id, i) => {
    const owner = owners[i];
    // An owner with a lock-out gap is already counted above; its account keeps the only other copy.
    if (owner === null || !hasCreds(users[i]) || !ownerOk[i]) return;
    r.credsRemoved++;
    strip.push({ id, owner });
  });
  const drop: { login: string; aid: AccountId }[] = [];
  members.forEach(({ login, m }, i) => {
    const v = judgeMember(m, rows[i], !!listed[i], persons[i], !!inOrgs[i]);
    // A `gap` is a listed roster entry, already counted by the lock-out check: the record is kept, not counted twice.
    if (v.v === "missing") r.twinMissing++;
    else if (v.v === "delete") {
      r.membersDeleted++;
      if (v.differs) r.twinDiffers++;
      drop.push({ login, aid: twinKeys(m).aid });
    }
  });
  if (!opts.apply) return r;

  // Counted again from what the writes find under their locks: a record changed since the read above is not touched.
  r.credsRemoved = r.membersDeleted = r.twinDiffers = 0;
  const [stripped_, dropped] = await Promise.all([pmap(strip, (s) => stripOne(s.id, s.owner), CHUNK), pmap(drop, (d) => deleteOne(d.login, d.aid), CHUNK)]);
  stripped_.forEach((o) => {
    if (o === "stripped") r.credsRemoved++;
    else if (o === "busy") r.busy++;
  });
  dropped.forEach((o) => {
    if (o === "gone") return;
    // A twin or check that changed since the read above: kept, and the next dry run reports it.
    if (o === "busy" || o.v !== "delete") r.busy++;
    else {
      r.membersDeleted++;
      if (o.differs) r.twinDiffers++;
    }
  });
  return r;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await run({ apply });
  const verb = apply ? "" : "to be ";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}); account records ${verb}stripped of credentials ${r.credsRemoved}; legacy member records ${r.memberRecords}, ${verb}deleted ${r.membersDeleted}.`);
  console.log(`Lock-out check (must be 0): person row missing ${r.personMissing}, account not in the person's workspaces ${r.notInOrgs}. Links made before M1 (must be 0, dead from M4): ${r.preM1Links}.`);
  console.log(`Kept and reported: twin missing ${r.twinMissing}, busy ${r.busy}. For information: deleted records that differed from their twin ${r.twinDiffers}.`);
  process.exitCode = r.personMissing || r.notInOrgs || r.twinMissing || r.preM1Links || r.busy ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("S2 stopped: the store could not be read or written. Nothing is half-written that a second run does not finish.");
    process.exitCode = 2;
  });
}
