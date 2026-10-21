// Links script of multi-workspace membership (rule 2756; docs/system/flows.md section 93.3): the precondition of release
// M4. M4 (contract, rule 2138) kills every calendar feed and booking link made before M1, a record with no `pid`/`aid`
// that only the legacy per-login pointer (`sec:feedof:{login}`, `sec:bookof:{login}:{provider}`) names, and its Script S2
// refuses to run while any such record is left. This script gives each such link its owner's ids and its M1-era pointer
// (`--apply`), and retires the ones it cannot carry (`--retire`). Run by hand from the live M3 build, after Script S1 and
// before the M4 release; never at build time and not as part of `npm run check`. M3 still reads the legacy pointer and the
// legacy brand key, so a run that stops halfway is harmless and the next run finishes it.
//
// Usage:  npx --no-install jiti scripts/multi-org-links.ts             (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/multi-org-links.ts --apply     (carry what can be carried; founder's yes)
//         npx --no-install jiti scripts/multi-org-links.ts --retire    (revoke the leftovers; founder's yes, see below)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved). Order: dry run, `--apply`, dry run again; `--retire` only after the founder has read that
// second dry run's counts (how many leftover links are still live in M3 and would stop) and said yes; `--apply` again
// (it stamps the legacy links a stale pointer blocked); then a final dry run, which must exit 0 (0 to stamp, 0 to align,
// 0 to retire, no conflict) before M4.
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop), every HOME login: a legacy
// owner of its own account, a legacy member of its `memberOf` (`legacyHomeFrom`, the only logins the legacy keys belong
// to). For each of its links (the feed, one booking link per provider) whose legacy pointer names a record made before M1:
//   --apply: `sec:feedof:{pid}:{aid}` (or `sec:bookof:{pid}:{aid}:{provider}`) is written with SET NX to the same hash,
//     then the record gets `pid`, `aid` and `home: true` with SET XX (exactly the record M1's home create writes; XX so
//     a record revoked meanwhile never comes back). Only when M3's own check (`loginHolds`) answers the same for the
//     stamped record as for the record as it is: a link that holds keeps holding, a dead one stays dead. The legacy
//     pointer is kept (M4's S2 owns it), so M3 and an older build keep resolving and revoking the link as before.
//   --retire: a link whose answer would change (`holdsDiffer`) and a record with one id and not the other or without a
//     login (`malformed`) are revoked through the app's own `revokeFeed(login)` / `revokeBook(login, provider)`: the
//     legacy pointer, the record, and an M1-era pointer only while it names that record. An M1-era pointer that names
//     another record which is gone or is the person's own home record of this account (R1's re-create after a rollback,
//     rule 2132: dead in M3, but M4 would bring it back) is deleted with that record; the live legacy link stays and the
//     next `--apply` stamps it. The dry run splits all of these into links live in M3 today (they stop working) and links
//     already dead.
// Both writers take the locks the app's link writers take (rule 2139: `lock:feed:{pid}:{aid}` then the legacy
// `lock:feed:{login}`, the booking ones alike) and read everything again under them first. A retire deletes while it
// still holds them (the revoke's `locked` option: no wait, no lock TTL to outlast), so a create of the same link answers
// busy meanwhile and no link created in between is revoked by mistake. Never written by either: a record that names
// another login and an M1-era pointer that names another link (another person's, or a live one). Those are counted and
// left for the founder to look at by hand.
// The person's chosen brand in the home account: M3 reads the legacy `activebrand:{login}` first, so with `--apply` its
// value is carried to `activebrand:{pid}:{aid}` (SET NX when absent) or written over an M1-era choice that differs (the
// legacy one is what the person sees now), the legacy key read again right before and the write skipped (busy) if it
// changed. A second run writes nothing (idempotent).
//
// Output is counts only: no email, id, hash or key is printed.
// Exit codes: 0 done with nothing left over; 1 finished with a leftover, a conflict or a busy lock, or a dry run with
// any write still pending; 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "../src/lib/keys";
import { normalizeEmail } from "../src/lib/auth";
import { legacyHomeFrom } from "../src/lib/membership";
import { ActiveBrandId } from "../src/lib/stored";
import { FEED_KEYS, legacyFeedLock, linkIds, revokeFeed } from "../src/lib/feed-token";
import { BOOK_KEYS, BOOK_PROVIDERS, legacyBookLock, revokeBook } from "../src/lib/booking-token";
import { loginHolds } from "../src/lib/secretary-feed";

export type LinksReport = {
  apply: boolean;
  retire: boolean;
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
  /** Home brand choices carried to an absent M1-era key (or would be). */
  brandsSet: number;
  /** Home brand choices written over an M1-era choice that differs (or would be): the legacy one wins, M3 reads it first. */
  brandsAligned: number;
  /** A legacy pointer naming no record: dead in every build, nothing to carry or retire. */
  dead: number;
  /** A record with one id and not the other, or without a login: dead in M3. Revoked by `--retire`. */
  malformed: number;
  /** A record that names another login than the pointer's. Never written: by hand. */
  loginConflicts: number;
  /** An M1-era pointer that names another link. A stale home one (see `staleHome`) is deleted by `--retire`; any other by hand. */
  pointerConflicts: number;
  /** A link whose `loginHolds` answer would change with the ids (it would die, or come back). Revoked by `--retire`. */
  holdsDiffer: number;
  /** Of what `--retire` resolves, as read before any write: links live in M3 today, which a retire stops. */
  retireLive: number;
  /** Of what `--retire` resolves, as read before any write: links already dead in M3 (a stale pointer's record included). */
  retireDead: number;
  /** Links revoked by `--retire`. */
  retired: number;
  /** A lock that was held, or a record that changed between the read and the write: run again. */
  busy: number;
};

const CHUNK = 50;
type Counter = Exclude<keyof LinksReport, "apply" | "retire">;
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
/**
 * The app's own revoke by address: the legacy pointer, the record, and its M1-era pointer only while it names the record.
 * `locked`: the script already holds the locks it would take, so it deletes at once (no wait, no lock TTL to outlast).
 */
const revoke = (l: Link) => (l.kind === "feed" ? revokeFeed(l.login, { locked: true }) : revokeBook(l.login, l.kind, { locked: true }));
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

type Done = { ok: true; current: boolean; stamp: boolean; pointer: boolean; retired: boolean };
/**
 * `live`, on a link `--retire` revokes: whether M3 serves it today. `stale`, on a pointer conflict: the M1-era pointer
 * names the person's own home record of this account, or no record at all (R1's re-create after a rollback, rule 2132).
 */
type Verdict = { ok: false; why: Fail; live?: boolean; stale?: boolean } | Done;
const NONE: Done = { ok: true, current: false, stamp: false, pointer: false, retired: false };
const BUSY: Verdict = { ok: false, why: "busy" };
/**
 * What `--retire` resolves: a link the stamp would change, a malformed record, and a stale M1-era home pointer. Never a
 * record of another login or a pointer to another link: those are by hand.
 */
const retirable = (v: Verdict): boolean => !v.ok && (v.why === "holds" || v.why === "malformed" || (v.why === "pointer" && v.stale === true));

/**
 * The record an M1-era pointer names, when it is not the legacy one: stale when it is gone (R1's create deleted it) or is
 * this person's home record of this account (R1's delete failed). Either is dead in M3, as a home record needs the legacy
 * pointer to name it, and would come back at M4, which reads only the ids and that pointer.
 */
function staleHome(l: Link, mineRec: unknown): boolean {
  if (mineRec === null || mineRec === undefined) return true;
  if (!isRecord(mineRec) || mineRec.home !== true) return false;
  const ids = linkIds(mineRec);
  return ids !== null && ids !== "legacy" && ids.pid === l.pid && ids.aid === l.aid;
}

/** Pure: what the script writes for one link, or why it writes nothing. Used for the dry-run counts and again under the locks. */
function decide(l: Link, legacy: unknown, rec: unknown, mine: unknown, mineRec: unknown, holds: Holds | null): Verdict {
  const fail = (why: Fail, live?: boolean, stale?: boolean): Verdict => ({ ok: false, why, live, stale });
  const hash = hashOf(legacy);
  if (hash === null) return NONE;
  if (!isRecord(rec)) return fail("dead");
  const ids = linkIds(rec);
  // Dead in M3: `loginHolds` refuses a record with one id, and the legacy check one without a login.
  if (ids === null || typeof rec.login !== "string") return fail("malformed", false);
  if (ids !== "legacy") return { ...NONE, current: true };
  if (normalizeEmail(rec.login) !== l.login) return fail("login");
  const ptr = hashOf(mine);
  if (ptr !== null && ptr !== hash) return fail("pointer", false, staleHome(l, mineRec));
  if (!holds || holds.before !== holds.after) return fail("holds", holds?.before === true);
  return { ...NONE, stamp: true, pointer: ptr === null };
}

/**
 * Under `lock:feed:{pid}:{aid}` then `lock:feed:{login}` (the booking ones alike, rule 2139): read the link again, decide,
 * and hand the verdict to `act`. Busy when either lock is held.
 */
async function underLocks(l: Link, act: (v: Verdict, hash: string | null, rec: unknown, mine: string | null) => Promise<Verdict>): Promise<Verdict> {
  const a = await db.lockOwned(newLock(l), LOCK_TTL);
  if (!a) return BUSY;
  try {
    const b = await db.lockOwned(oldLock(l), LOCK_TTL);
    if (!b) return BUSY;
    try {
      const [legacy, rawMine] = await Promise.all([db.get<unknown>(legacyKey(l)), db.get<unknown>(mineKey(l))]);
      const hash = hashOf(legacy);
      const mine = hashOf(rawMine);
      const other = mine !== null && mine !== hash ? mine : null;
      const [rec, mineRec] = await Promise.all([hash ? db.get<unknown>(recKey(l, hash)) : null, other ? db.get<unknown>(recKey(l, other)) : null]);
      return await act(decide(l, legacy, rec, rawMine, mineRec, await holdsOf(l, rec)), hash, rec, mine);
    } finally {
      await db.unlockOwned(oldLock(l), b).catch(() => {});
    }
  } finally {
    await db.unlockOwned(newLock(l), a).catch(() => {});
  }
}

/** `--apply` for one link: the M1-era pointer (SET NX), then the stamped record (SET XX). */
const applyLink = (l: Link) =>
  underLocks(l, async (v, hash, rec) => {
    if (!v.ok || !v.stamp || !hash || !isRecord(rec)) return v;
    // The pointer first: until the record names its ids, M3 still resolves it through the legacy pointer alone.
    if (v.pointer && !(await db.setNx(mineKey(l), hash))) return BUSY;
    // XX: a revoke that went ahead without the lock (B1-R10) and deleted the record meanwhile is never undone. The pointer
    // left behind then names no record, which is dead in every build.
    return (await db.setXx(recKey(l, hash), stampOf(l, rec))) ? v : BUSY;
  });

/**
 * `--retire` for one link, under the locks: a stale M1-era home pointer goes with the record it names (the live legacy
 * link stays, and the next `--apply` stamps it); anything else retirable goes through the app's own revoke.
 */
const retireLink = (l: Link) =>
  underLocks(l, async (v, _hash, _rec, mine) => {
    if (!retirable(v)) return v.ok && v.stamp ? BUSY : v;
    if (!v.ok && v.why === "pointer") {
      if (mine) await Promise.all([db.del(recKey(l, mine)), db.del(mineKey(l))]);
    } else await revoke(l);
    return { ...NONE, retired: true };
  });

/** The legacy brand choice to write to the M1-era key: carried when that key is empty, written over it when it differs. */
function brandWrite(legacy: unknown, fresh: unknown): { id: string; carry: boolean } | null {
  const old = ActiveBrandId.safeParse(legacy);
  if (legacy === null || legacy === undefined || !old.success) return null;
  if (fresh === null || fresh === undefined) return { id: old.data, carry: true };
  const cur = ActiveBrandId.safeParse(fresh);
  return cur.success && cur.data === old.data ? null : { id: old.data, carry: false };
}

export async function run(opts: { apply: boolean; retire?: boolean }): Promise<LinksReport> {
  const retire = opts.retire === true;
  const r: LinksReport = { apply: opts.apply, retire, accounts: 0, missing: 0, homes: 0, links: 0, current: 0, stamped: 0, pointersSet: 0, brandsSet: 0, brandsAligned: 0, dead: 0, malformed: 0, loginConflicts: 0, pointerConflicts: 0, holdsDiffer: 0, retireLive: 0, retireDead: 0, retired: 0, busy: 0 };
  const count = (v: Verdict) => {
    if (!v.ok) {
      r[FAIL_FIELD[v.why]]++;
      return;
    }
    if (v.current) r.current++;
    if (v.stamp) r.stamped++;
    if (v.pointer) r.pointersSet++;
    if (v.retired) r.retired++;
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
  // Round 4: the records the legacy pointers name, and the ones an M1-era pointer names when it is another. Round 5: M3's
  // own check on the records made before M1.
  const named = links.flatMap((l, i) => {
    const h = hashOf(legacies[i]);
    return h ? [{ l, i, key: recKey(l, h) }] : [];
  });
  r.links = named.length;
  const others = named.flatMap((x, j) => {
    const m = hashOf(mines[x.i]);
    return m && m !== hashOf(legacies[x.i]) ? [{ j, key: recKey(x.l, m) }] : [];
  });
  const [recs, otherRecs] = await Promise.all([mgetChunked<unknown>(named.map((x) => x.key)), mgetChunked<unknown>(others.map((o) => o.key))]);
  const mineRecs = new Map(others.map((o, n) => [o.j, otherRecs[n]] as const));
  const holds = await pmap(named, (x, j) => holdsOf(x.l, recs[j]), CHUNK);

  const work: Link[] = [];
  const leftovers: { l: Link; v: Verdict }[] = [];
  named.forEach((x, j) => {
    const v = decide(x.l, legacies[x.i], recs[j], mines[x.i], mineRecs.get(j) ?? null, holds[j]);
    count(v);
    if (v.ok && v.stamp) work.push(x.l);
    if (retirable(v)) {
      if (!v.ok && v.live) r.retireLive++;
      else r.retireDead++;
      leftovers.push({ l: x.l, v });
    }
  });
  const brands: { h: Home; id: string; carry: boolean; seen: unknown }[] = [];
  homes.forEach((h, i) => {
    const w = brandWrite(legacyBrands[i], freshBrands[i]);
    if (w) brands.push({ h, ...w, seen: legacyBrands[i] });
  });
  r.brandsSet = brands.filter((b) => b.carry).length;
  r.brandsAligned = brands.length - r.brandsSet;

  // The writes are counted again from what they find under their locks: a link changed since the read above is not
  // overwritten, and is counted under what it is now. What the read above left alone stays counted as it was.
  if (opts.apply) {
    r.stamped = r.pointersSet = 0;
    const done = await pmap(work, applyLink, CHUNK);
    done.forEach(count);
    // The brand choice, with no lock as the app's own writer: SET NX when the M1-era key is empty (a choice made
    // meanwhile writes both keys, and wins), else the legacy value over the M1-era one, only while the legacy key still
    // holds what was read (read again right before; a choice made meanwhile is busy and the next run looks again).
    const key = (h: Home) => personKey.activeBrand(h.pid, h.aid);
    const overwrite = async (h: Home, id: string, seen: unknown) => {
      if ((await db.get<unknown>(accountKey.activeBrand(h.login))) !== seen) return false;
      await db.set(key(h), id);
      return true;
    };
    const wrote = await pmap(brands, ({ h, id, carry, seen }) => (carry ? db.setNx(key(h), id) : overwrite(h, id, seen)), CHUNK);
    r.brandsSet = brands.filter((b, k) => b.carry && wrote[k]).length;
    r.brandsAligned = brands.filter((b, k) => !b.carry && wrote[k]).length;
    r.busy += wrote.filter((w) => !w).length;
  }
  if (retire) {
    leftovers.forEach(({ v }) => {
      if (!v.ok) r[FAIL_FIELD[v.why]]--;
    });
    const done = await pmap(leftovers, ({ l }) => retireLink(l), CHUNK);
    done.forEach(count);
  }
  return r;
}

/**
 * 1 while anything is left: a conflict or leftover, a busy lock, or, on a dry run, any write still pending (a stamp, a
 * pointer, a brand choice, a link to retire). M4's precondition is a final dry run that exits 0.
 */
export function exitCodeOf(r: LinksReport): 0 | 1 {
  const left = r.malformed + r.loginConflicts + r.pointerConflicts + r.holdsDiffer + r.busy;
  const pending = r.apply || r.retire ? 0 : r.stamped + r.pointersSet + r.brandsSet + r.brandsAligned + r.retireLive + r.retireDead;
  return left + pending > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const retire = process.argv.includes("--retire");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await run({ apply, retire });
  const verb = apply ? "set" : "to set";
  console.log(`${apply || retire ? "Written" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}), home logins ${r.homes}, links ${r.links} (already current ${r.current}); links stamped ${verb} ${r.stamped}, pointers ${verb} ${r.pointersSet}, brand choices carried ${verb} ${r.brandsSet}, brand choices aligned ${verb} ${r.brandsAligned}.`);
  console.log(`To retire, as read before any write: live in M3 today ${r.retireLive}, already dead ${r.retireDead}; retired ${r.retired}.`);
  console.log(`Left as they are: dead pointers ${r.dead}, malformed records ${r.malformed}, answer would change ${r.holdsDiffer}, login conflicts ${r.loginConflicts}, pointer conflicts ${r.pointerConflicts}, busy ${r.busy}.`);
  process.exitCode = exitCodeOf(r);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("The links script stopped: the store could not be read or written. Nothing is half-written that a second run does not finish.");
    process.exitCode = 2;
  });
}
