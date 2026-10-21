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
//   - the account record loses `passHash`, `sessionsAfter` and `devicesAfter`, under `lock:user` and read again first,
//     but only while its owner's `person:` row exists and parses (the person holds the credentials from M4). An account
//     whose owner has no readable person row is counted and left whole;
//   - every legacy `member:{login}` record named by a roster entry is deleted under `lock:team` → `lock:member` (rule
//     2139 order), read again first, only when its twin `mbr:{memberOf}:{pid}` exists and agrees on role, acceptedAt
//     and pause, the roster of `memberOf` lists the person, and the person's `person:` row exists. A record whose twin
//     is missing or differs is counted and kept: it is reported, never deleted. Records are found through the rosters
//     (Redis keys are not listed): a record no roster names is never reached, so never deleted (a removal already
//     deletes it, src/lib/team.ts `deleteMembership`);
//   - the legacy per-login link pointers (`sec:feedof:{login}`, `sec:bookof:{login}:{provider}`) are read to count the
//     calendar and booking links made before M1 (a record without `pid` and `aid`): dead from M4. Nothing is written for
//     them; the release pull request names the number.
// A second run strips and deletes nothing (idempotent).
//
// Output is counts only: no email, id or key is printed.
// Exit codes: 0 done with nothing left over; 1 finished with at least one record kept (twin missing or different, no
// person row) or a busy lock; 2 could not run.
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
  /** Account records that still carry a credential field: stripped (or, in a dry run, that would be). */
  credsRemoved: number;
  /** Account records with a credential field whose owner has no readable `person:` row: kept whole. */
  ownerNoPerson: number;
  /** Legacy `member:` records found through the rosters. */
  memberRecords: number;
  /** Legacy `member:` records whose twin matches: deleted (or would be). */
  membersDeleted: number;
  /** A legacy `member:` record with no `mbr:` twin or no roster entry: kept and reported. */
  twinMissing: number;
  /** A legacy `member:` record whose twin differs (role, acceptedAt or pause), or whose person has no row: kept. */
  twinMismatch: number;
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

/** `mgetChunked` over the keys that are given, aligned with the input: null where no key was. */
async function mgetSome(keys: readonly (string | null)[]): Promise<unknown[]> {
  const values = await mgetChunked<unknown>(keys.filter((k): k is string => k !== null));
  let at = 0;
  return keys.map((k) => (k === null ? null : values[at++]));
}

/** The account record without the three credential fields, every other field byte for byte. */
function stripped(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!(CREDS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

type MemberVerdict = "delete" | "missing" | "mismatch";
/** Pure: whether a legacy member record may go. Its twin is the row of its own `memberOf` account and person id. */
function judgeMember(m: Member, row: unknown, listed: boolean, person: unknown): MemberVerdict {
  if (row === null || row === undefined || !listed) return "missing";
  const r = MembershipRow.safeParse(row);
  if (!r.success) return "mismatch";
  const twin = r.data;
  const same = twin.aid === m.memberOf && twin.pid === memberPid(m) && twin.role === m.role && twin.acceptedAt === m.acceptedAt && (twin.disabled ?? null) === (m.disabled ?? null);
  return same && personOk(person) ? "delete" : "mismatch";
}
/** The keys a member record's verdict is read from: its twin row, the roster entry and the person row. */
const twinKeys = (m: Member) => {
  const aid = storedAccountId(m.memberOf);
  const pid = storedPersonId(memberPid(m));
  return { aid, pid, row: accountKey.membership(aid, pid), person: personKey.person(pid) };
};

/** Strip one account record under `lock:user`, read again first. */
async function stripOne(id: string, ownerPid: PersonId): Promise<"stripped" | "none" | "noPerson" | "busy"> {
  return withUserLock(id, async () => {
    const [raw, person] = await Promise.all([db.get<unknown>(accountKey.user(id)), db.get<unknown>(personKey.person(ownerPid))]);
    if (!isRecord(raw) || !hasCreds(raw)) return "none" as const;
    // The owner named now may differ from the bulk read's (an ownership change meanwhile): run again.
    if (storedPersonId(typeof raw.ownerPid === "string" ? raw.ownerPid : id) !== ownerPid) return "busy" as const;
    if (!personOk(person)) return "noPerson" as const;
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
      const [row, listed, person] = await Promise.all([db.get<unknown>(k.row), db.sismember(accountKey.members(k.aid), k.pid), db.get<unknown>(k.person)]);
      const v = judgeMember(m, row, !!listed, person);
      if (v === "delete") await db.del(accountKey.member(login));
      return v;
    });
    return r ?? ("gone" as const);
  }).catch((e: unknown) => {
    if (isTimeout(e)) return "busy" as const;
    throw e;
  });
}

export async function run(opts: { apply: boolean }): Promise<ContractReport> {
  const r: ContractReport = { apply: opts.apply, accounts: 0, missing: 0, credsRemoved: 0, ownerNoPerson: 0, memberRecords: 0, membersDeleted: 0, twinMissing: 0, twinMismatch: 0, busy: 0, preM1Links: 0 };

  // Round 1: the accounts, their rosters and their owners' person rows.
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const [users, rosters] = await Promise.all([mgetChunked<unknown>(ids.map((id) => accountKey.user(id))), pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK)]);
  const owners = ids.map((id, i) => {
    const u = users[i];
    return isRecord(u) ? storedPersonId(typeof u.ownerPid === "string" ? u.ownerPid : id) : null;
  });
  r.missing = owners.filter((o) => o === null).length;

  // Round 2: the owners' person rows, every roster entry's legacy member record (one per login, whatever the roster).
  const logins = [...new Set(rosters.flat().map((e) => normalizeEmail(e)))];
  const [ownerPersons, memberRecs] = await Promise.all([
    mgetSome(owners.map((o) => (o === null ? null : personKey.person(o)))),
    mgetChunked<Member>(logins.map((l) => accountKey.member(l))),
  ]);
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
  const [rows, listed, persons, pointers] = await Promise.all([
    mgetChunked<unknown>(members.map(({ m }) => twinKeys(m).row)),
    pmap(members, ({ m }) => db.sismember(accountKey.members(twinKeys(m).aid), twinKeys(m).pid), CHUNK),
    mgetChunked<unknown>(members.map(({ m }) => twinKeys(m).person)),
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
    if (owner === null || !hasCreds(users[i])) return;
    if (!personOk(ownerPersons[i])) {
      r.ownerNoPerson++;
      return;
    }
    r.credsRemoved++;
    strip.push({ id, owner });
  });
  const drop: { login: string; aid: AccountId }[] = [];
  members.forEach(({ login, m }, i) => {
    const v = judgeMember(m, rows[i], !!listed[i], persons[i]);
    if (v === "missing") r.twinMissing++;
    else if (v === "mismatch") r.twinMismatch++;
    else {
      r.membersDeleted++;
      drop.push({ login, aid: twinKeys(m).aid });
    }
  });
  if (!opts.apply) return r;

  // Counted again from what the writes find under their locks: a record changed since the read above is not touched.
  r.credsRemoved = r.membersDeleted = 0;
  const [stripped_, dropped] = await Promise.all([pmap(strip, (s) => stripOne(s.id, s.owner), CHUNK), pmap(drop, (d) => deleteOne(d.login, d.aid), CHUNK)]);
  stripped_.forEach((o) => {
    if (o === "stripped") r.credsRemoved++;
    else if (o === "noPerson") r.ownerNoPerson++;
    else if (o === "busy") r.busy++;
  });
  dropped.forEach((o) => {
    if (o === "delete") r.membersDeleted++;
    else if (o === "missing") r.twinMissing++;
    else if (o === "mismatch") r.twinMismatch++;
    else if (o === "busy") r.busy++;
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
  console.log(`Kept and reported: owner without a person row ${r.ownerNoPerson}, twin missing ${r.twinMissing}, twin different ${r.twinMismatch}, busy ${r.busy}. Links made before M1 (dead from M4): ${r.preM1Links}.`);
  process.exitCode = r.ownerNoPerson || r.twinMissing || r.twinMismatch || r.busy ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("S2 stopped: the store could not be read or written. Nothing is half-written that a second run does not finish.");
    process.exitCode = 2;
  });
}
