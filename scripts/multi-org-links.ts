// Links script of multi-workspace membership (rule 2756; docs/system/flows.md section 93.3): the precondition of release
// M4. M4 (contract, rule 2138) kills every calendar feed and booking link made before M1, a record with no `pid`/`aid`
// that only the legacy per-login pointer (`sec:feedof:{login}`, `sec:bookof:{login}:{provider}`) names. This script gives
// each such link its owner's ids and its M1-era pointer, so it keeps working through M4. Run by hand ONCE, from the live
// M3 build and only on the founder's yes (it writes production data), after Script S1 and before the M4 release; never at
// build time and not as part of `npm run check`. M3 still reads the legacy pointer and the legacy brand key, so a run
// that stops halfway is harmless and the next run finishes it.
//
// Usage:  npx --no-install jiti scripts/multi-org-links.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/multi-org-links.ts --apply    (write what is missing)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop), every HOME login: a legacy
// owner of its own account, a legacy member of its `memberOf` (`legacyHomeFrom`, the only logins the legacy keys belong
// to). For each of its links (the feed, one booking link per provider) whose legacy pointer names a record made before M1:
//   - `sec:feedof:{pid}:{aid}` (or `sec:bookof:{pid}:{aid}:{provider}`) is written with SET NX to the same hash, then
//   - the record gets `pid`, `aid` and `home: true`, exactly the record M1's home create writes.
// Both under the locks the app's link writers take (rule 2139: `lock:feed:{pid}:{aid}` then the legacy `lock:feed:{login}`,
// the booking ones alike), with everything read again under them first. The legacy pointer is never deleted (M4's S2 owns
// that), so M3 and an older build keep resolving and revoking the link as before.
// A link is stamped only when M3's own check (`loginHolds`) answers the same for the stamped record as for the record as
// it is: a link that holds keeps holding, a dead one stays dead. It never overwrites: a record that names another login,
// a record with one id and not the other, an M1-era pointer that names another link, and a link whose answer would change
// are counted and left as they are.
// The person's chosen brand in the home account (`activebrand:{login}`) is carried to `activebrand:{pid}:{aid}` with SET NX;
// an M1-era choice that differs is counted and left. A second run writes nothing (idempotent).
//
// Output is counts only: no email, id, hash or key is printed.
// Exit codes: 0 done with no conflict; 1 finished with at least one conflict or busy lock; 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "../src/lib/keys";
import { normalizeEmail } from "../src/lib/auth";
import { legacyHomeFrom } from "../src/lib/membership";
import { ActiveBrandId } from "../src/lib/stored";
import { FEED_KEYS, legacyFeedLock, linkIds } from "../src/lib/feed-token";
import { BOOK_KEYS, BOOK_PROVIDERS, legacyBookLock } from "../src/lib/booking-token";
import { loginHolds } from "../src/lib/secretary-feed";

export type LinksReport = {
  apply: boolean;
  accounts: number;
  /** In `users:all` with no record (a deletion that stopped halfway): left alone. */
  missing: number;
  /** Home logins read: legacy owners and legacy members of their `memberOf`. */
  homes: number;
  /** Legacy pointers that name a record. */
  links: number;
  /** Records that already name their person and account (made from M1, or stamped by an earlier run). */
  current: number;
  /** Records made before M1 stamped with `pid`/`aid` (or, in a dry run, that would be). */
  stamped: number;
  /** M1-era pointers written (or would be); a stamp whose pointer an earlier run already wrote writes none. */
  pointersSet: number;
  /** Home brand choices carried to the M1-era key (or would be). */
  brandsSet: number;
  /** A legacy pointer naming no record: dead in every build, nothing to carry. */
  dead: number;
  /** A record with one id and not the other, or without a login: dead in M3, left as it is. */
  malformed: number;
  /** A record that names another login than the pointer's. Never stamped. */
  loginConflicts: number;
  /** An M1-era pointer that names another link. Never overwritten. */
  pointerConflicts: number;
  /** A link whose `loginHolds` answer would change with the ids (it would die, or come back). Never stamped. */
  holdsDiffer: number;
  /** An M1-era brand choice that differs from the legacy one. Never overwritten. */
  brandConflicts: number;
  /** A lock that was held, or a record that changed between the read and the write: run again. */
  busy: number;
};

const CHUNK = 50;
type Counter = Exclude<keyof LinksReport, "apply">;
type Fail = "dead" | "malformed" | "login" | "pointer" | "holds" | "busy";
const FAIL_FIELD: Record<Fail, Counter> = { dead: "dead", malformed: "malformed", login: "loginConflicts", pointer: "pointerConflicts", holds: "holdsDiffer", busy: "busy" };

/** A home login: the person, the account the legacy keys belong to, and the address they are named by. */
type Home = { pid: PersonId; aid: AccountId; login: string };
type Kind = "feed" | (typeof BOOK_PROVIDERS)[number];
type Link = Home & { kind: Kind };
const KINDS: readonly Kind[] = ["feed", ...BOOK_PROVIDERS];

const legacyKey = (l: Link) => (l.kind === "feed" ? FEED_KEYS.of(l.login) : BOOK_KEYS.of(l.login, l.kind));
const mineKey = (l: Link) => (l.kind === "feed" ? personKey.feedOf(l.pid, l.aid) : personKey.bookOf(l.pid, l.aid, l.kind));
const recKey = (l: Link, hash: string) => (l.kind === "feed" ? FEED_KEYS.rec(hash) : BOOK_KEYS.rec(hash));
const newLock = (l: Link) => (l.kind === "feed" ? personKey.feedLock(l.pid, l.aid) : personKey.bookLock(l.pid, l.aid, l.kind));
const oldLock = (l: Link) => (l.kind === "feed" ? legacyFeedLock(l.login) : legacyBookLock(l.login, l.kind));
const LOCK_TTL = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hashOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** The record as M1's home create writes it: the same fields plus the owner's ids and `home`. */
const stampOf = (l: Link, rec: Record<string, unknown>) => ({ ...rec, pid: l.pid, aid: l.aid, home: true as const });

/** What M3's own check answers for the record as it is and as it would be stamped. Reads only. */
type Holds = { before: boolean; after: boolean };
async function holdsOf(l: Link, rec: unknown): Promise<Holds | null> {
  if (!isRecord(rec) || typeof rec.login !== "string" || linkIds(rec) !== "legacy") return null;
  // `loginHolds` checks every field's type itself (a missing scope or date refuses or is not a reason to refuse).
  type Rec = Parameters<typeof loginHolds>[0];
  const [before, after] = await Promise.all([loginHolds(rec as unknown as Rec), loginHolds(stampOf(l, rec) as unknown as Rec)]);
  return { before, after };
}

type Done = { ok: true; current: boolean; stamp: boolean; pointer: boolean };
type Verdict = { ok: false; why: Fail } | Done;
const NONE: Done = { ok: true, current: false, stamp: false, pointer: false };

/** Pure: what the script writes for one link, or why it writes nothing. Used for the dry-run counts and again under the locks. */
function decide(l: Link, legacy: unknown, rec: unknown, mine: unknown, holds: Holds | null): Verdict {
  const fail = (why: Fail): Verdict => ({ ok: false, why });
  const hash = hashOf(legacy);
  if (hash === null) return NONE;
  if (!isRecord(rec)) return fail("dead");
  const ids = linkIds(rec);
  if (ids === null || typeof rec.login !== "string") return fail("malformed");
  if (ids !== "legacy") return { ...NONE, current: true };
  if (normalizeEmail(rec.login) !== l.login) return fail("login");
  const ptr = hashOf(mine);
  if (ptr !== null && ptr !== hash) return fail("pointer");
  if (!holds || holds.before !== holds.after) return fail("holds");
  return { ok: true, current: false, stamp: true, pointer: ptr === null };
}

/** Stamp one link under `lock:feed:{pid}:{aid}` → `lock:feed:{login}` (the booking ones alike), reading it all again first. */
async function applyLink(l: Link): Promise<Verdict> {
  const busy: Verdict = { ok: false, why: "busy" };
  const a = await db.lockOwned(newLock(l), LOCK_TTL);
  if (!a) return busy;
  try {
    const b = await db.lockOwned(oldLock(l), LOCK_TTL);
    if (!b) return busy;
    try {
      const [legacy, mine] = await Promise.all([db.get<unknown>(legacyKey(l)), db.get<unknown>(mineKey(l))]);
      const hash = hashOf(legacy);
      const rec = hash ? await db.get<unknown>(recKey(l, hash)) : null;
      const v = decide(l, legacy, rec, mine, await holdsOf(l, rec));
      if (!v.ok || !v.stamp || !hash || !isRecord(rec)) return v;
      // The pointer first: until the record names its ids, M3 still resolves it through the legacy pointer alone.
      if (v.pointer && !(await db.setNx(mineKey(l), hash))) return busy;
      await db.set(recKey(l, hash), stampOf(l, rec));
      return v;
    } finally {
      await db.unlockOwned(oldLock(l), b).catch(() => {});
    }
  } finally {
    await db.unlockOwned(newLock(l), a).catch(() => {});
  }
}

/** The legacy brand choice to carry, "same" when the M1-era key already holds it, "conflict" when it holds another. */
function brandVerdict(legacy: unknown, fresh: unknown): string | "none" | "same" | "conflict" {
  const old = ActiveBrandId.safeParse(legacy);
  if (legacy === null || legacy === undefined || !old.success) return "none";
  if (fresh === null || fresh === undefined) return old.data;
  const cur = ActiveBrandId.safeParse(fresh);
  return cur.success && cur.data === old.data ? "same" : "conflict";
}

export async function run(opts: { apply: boolean }): Promise<LinksReport> {
  const r: LinksReport = { apply: opts.apply, accounts: 0, missing: 0, homes: 0, links: 0, current: 0, stamped: 0, pointersSet: 0, brandsSet: 0, dead: 0, malformed: 0, loginConflicts: 0, pointerConflicts: 0, holdsDiffer: 0, brandConflicts: 0, busy: 0 };
  const count = (v: Verdict) => {
    if (!v.ok) {
      r[FAIL_FIELD[v.why]]++;
      return;
    }
    if (v.current) r.current++;
    if (v.stamp) r.stamped++;
    if (v.pointer) r.pointersSet++;
  };

  // Round 1: the accounts and their rosters. Round 2: each roster entry's legacy member record.
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const [users, rosters] = await Promise.all([mgetChunked<unknown>(ids.map((id) => accountKey.user(id))), pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK)]);
  const entries = ids.flatMap((id, i) => rosters[i].map((e) => ({ aid: storedAccountId(id), pid: storedPersonId(e) })));
  const memberRecs = await mgetChunked<unknown>(entries.map((e) => accountKey.member(e.pid)));

  // The home logins: a legacy owner of its own account, a legacy member of its `memberOf` (`legacyHomeFrom`).
  const homes: Home[] = [];
  ids.forEach((id, i) => {
    const u = users[i];
    if (!isRecord(u)) {
      r.missing++;
      return;
    }
    const pid = storedPersonId(id);
    const aid = storedAccountId(id);
    if (typeof u.ownerPid !== "string" && typeof u.email === "string" && legacyHomeFrom(pid, u, null) === aid) homes.push({ pid, aid, login: normalizeEmail(u.email) });
  });
  entries.forEach((e, i) => {
    const m = memberRecs[i];
    if (isRecord(m) && typeof m.email === "string" && legacyHomeFrom(e.pid, null, m) === e.aid) homes.push({ pid: e.pid, aid: e.aid, login: normalizeEmail(m.email) });
  });
  r.homes = homes.length;

  // Round 3: every home's legacy pointers, M1-era pointers and both brand keys, in one batch.
  const links: Link[] = homes.flatMap((h) => KINDS.map((kind) => ({ ...h, kind })));
  const [legacies, mines, legacyBrands, freshBrands] = await Promise.all([
    mgetChunked<unknown>(links.map(legacyKey)),
    mgetChunked<unknown>(links.map(mineKey)),
    mgetChunked<unknown>(homes.map((h) => accountKey.activeBrand(h.login))),
    mgetChunked<unknown>(homes.map((h) => personKey.activeBrand(h.pid, h.aid))),
  ]);
  // Round 4: the records the legacy pointers name. Round 5: M3's own check on the records made before M1.
  const named = links.flatMap((l, i) => {
    const h = hashOf(legacies[i]);
    return h ? [{ l, i, key: recKey(l, h) }] : [];
  });
  r.links = named.length;
  const recs = await mgetChunked<unknown>(named.map((x) => x.key));
  const holds = await pmap(named, (x, j) => holdsOf(x.l, recs[j]), CHUNK);

  const work: Link[] = [];
  named.forEach((x, j) => {
    const v = decide(x.l, legacies[x.i], recs[j], mines[x.i], holds[j]);
    count(v);
    if (v.ok && v.stamp) work.push(x.l);
  });
  const brands: { h: Home; id: string }[] = [];
  homes.forEach((h, i) => {
    const v = brandVerdict(legacyBrands[i], freshBrands[i]);
    if (v === "conflict") r.brandConflicts++;
    else if (v !== "none" && v !== "same") brands.push({ h, id: v });
  });
  r.brandsSet = brands.length;
  if (!opts.apply) return r;

  // The writes are counted again from what they find under their locks: a link changed since the read above is not
  // overwritten, and is counted under what it is now. What the read above left alone stays counted as it was.
  r.stamped = r.pointersSet = 0;
  const done = await pmap(work, applyLink, CHUNK);
  done.forEach(count);
  // The brand choice is written with SET NX, as the app's own writer needs no lock for it: a choice made meanwhile wins.
  const carried = await pmap(brands, ({ h, id }) => db.setNx(personKey.activeBrand(h.pid, h.aid), id), CHUNK);
  r.brandsSet = carried.filter(Boolean).length;
  r.busy += carried.length - r.brandsSet;
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
  const verb = apply ? "set" : "to set";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}), home logins ${r.homes}, links ${r.links} (already current ${r.current}); links stamped ${verb} ${r.stamped}, pointers ${verb} ${r.pointersSet}, brand choices ${verb} ${r.brandsSet}.`);
  console.log(`Left as they are: dead pointers ${r.dead}, malformed records ${r.malformed}, login conflicts ${r.loginConflicts}, pointer conflicts ${r.pointerConflicts}, answer would change ${r.holdsDiffer}, brand conflicts ${r.brandConflicts}, busy ${r.busy}.`);
  process.exitCode = r.malformed || r.loginConflicts || r.pointerConflicts || r.holdsDiffer || r.brandConflicts || r.busy ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("The links script stopped: the store could not be read or written. Nothing is half-written that a second run does not finish.");
    process.exitCode = 2;
  });
}
