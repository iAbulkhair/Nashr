import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { json, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, currentUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getPerson } from "@/lib/person";
import { deleteMembership, writeMembership } from "@/lib/team";
import { createFeed, FEED_KEYS, getFeedStatus, hashFeedToken, resolveFeed, revokeFeed, type FeedRecord, type LinkOwner } from "@/lib/feed-token";
import { BOOK_KEYS, createBook, getBookStatus, hashBookToken, resolveBook, revokeBook } from "@/lib/booking-token";
import { linkOwner, loginHolds } from "@/lib/secretary-feed";
import * as feedRoute from "@/app/api/secretary/feed/[token]/route";
import * as manageRoute from "@/app/api/secretary/feed/route";

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand (docs/specs/2026-10-18-multi-org.md section 9): the calendar feed and the booking
 * links per (person, account). Rules 2119 (a link lives in one account and dies with its membership, even when the
 * revoke is skipped), 2131 (a person suspension ends every link, an account suspension only that account's), 2132 (a home
 * link keeps R1's legacy pointer; a link made before M1 still resolves and is revoked) and 2139 (the feed and booking
 * locks are leaves: new first, legacy inside).
 *
 * The person is a legacy member of H (its home: `pid` = its address) and joins O with `writeMembership`, as release M2's
 * accept will. Links are made through the management route signed in to each account, or with the library and a
 * `LinkOwner` built from stored ids.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", ""); });

let ipN = 0;
const nextIp = () => `10.77.${(++ipN >> 8) & 255}.${ipN & 255}`;
const callFeed = (token: string) =>
  feedRoute.GET(new Request(`http://x/api/secretary/feed/${token}`, { headers: { "x-forwarded-for": nextIp() } }), params({ token }));
const tokenOf = (url: string) => url.replace(/^.*\/feed\//, "").replace(/\.ics$/, "");
const aidOf = (u: User): AccountId => storedAccountId(acct(u));
const as = async (email: string, account: User) => { await signIn(email, { acct: acct(account) }); return (await currentUser())!; };
/** Make a feed link through the route, signed in to `account`; the plain token. */
const routeFeed = async (email: string, account: User) => {
  await as(email, account);
  const r = await manageRoute.POST(json("/api/secretary/feed", "POST", {}));
  expect(r.status).toBe(200);
  return tokenOf((await r.json()).url as string);
};
const live = async (token: string) => (await callFeed(token)).status;

/** A person who is a legacy member of H (home) and a member of O. */
async function twoAccounts() {
  const [H, O] = [await newUser("lh"), await newUser("lo")];
  const p = await newMember(H, "member", "lp");
  const pid = storedPersonId(p.email);
  await writeMembership(aidOf(O), pid, { aid: aidOf(O), pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: storedPersonId(O.email) }, { home: false, teamLocked: true });
  const [uH, uO] = [await as(p.email, H), await as(p.email, O)];
  signOut();
  return { H, O, email: p.email, pid, uH, uO, whoH: linkOwner(uH)!, whoO: linkOwner(uO)! };
}

describe("rule 2119: a link lives in one account", () => {
  it("links in H and O each resolve; each record names its own account and scope; a record moved to the other account's scope is refused", async () => {
    const t = await twoAccounts();
    expect(t.whoH).toEqual({ pid: t.pid, aid: aidOf(t.H), login: t.email, home: true });
    expect(t.whoO).toEqual({ pid: t.pid, aid: aidOf(t.O), login: t.email, home: false });
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    expect(await live(h)).toBe(200);
    expect(await live(o)).toBe(200);

    const [recH, recO] = [(await resolveFeed(h))!.rec, (await resolveFeed(o))!.rec];
    expect(recH).toMatchObject({ pid: t.pid, aid: aidOf(t.H), scope: sc(t.uH), home: true, login: t.email });
    expect(recO).toMatchObject({ pid: t.pid, aid: aidOf(t.O), scope: sc(t.uO) });
    expect(recO.home).toBeUndefined();
    // Each account's pointer names its own link; only the home one writes the legacy per-login pointer.
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBe(hashFeedToken(h));
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.O)))).toBe(hashFeedToken(o));
    expect(await db.get(FEED_KEYS.of(t.email))).toBe(hashFeedToken(h));

    // A link reaches only its own account's brands: O's record with H's scope (or the reverse) does not hold.
    expect(await loginHolds({ ...recO, scope: sc(t.uH) })).toBe(false);
    expect(await loginHolds({ ...recH, scope: sc(t.uO) })).toBe(false);
    expect(await loginHolds(recO)).toBe(true);

    // The status each account shows is its own link.
    expect((await getFeedStatus(t.whoO, sc(t.uO))).exists).toBe(true);
    expect((await getFeedStatus(t.whoO, sc(t.uO))).createdAt).toBe(recO.createdAt);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).createdAt).toBe(recH.createdAt);
  });

  it("stopping the link in H (route DELETE) leaves O's; stopping O's leaves nothing", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    await as(t.email, t.H);
    expect((await manageRoute.DELETE()).status).toBe(200);
    expect(await live(h)).toBe(404);
    expect(await live(o)).toBe(200);
    expect(await db.get(FEED_KEYS.of(t.email))).toBeNull();
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBeNull();
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(h)))).toBeNull();

    await revokeFeed(t.whoO);
    expect(await live(o)).toBe(404);
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.O)))).toBeNull();
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(o)))).toBeNull();
  });

  it("deleteMembership(O) revokes O's feed and booking links and leaves H's; a link minted after the removal (planted race) is refused at read time", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    const bookO = (await createBook(t.whoO, sc(t.uO), "calcom", "ar")) as string;
    const bookH = (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string;

    await deleteMembership(aidOf(t.O), t.pid, { home: false, teamLocked: true });
    expect(await live(o)).toBe(404);
    expect(await live(h)).toBe(200);
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.O)))).toBeNull();
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.O), "calcom"))).toBeNull();
    expect(await resolveBook(bookO)).toBeNull();
    expect(await resolveBook(bookH)).not.toBeNull();

    // The race: a create that passed its route check before the removal writes after the revoke. Its record and
    // pointer exist, and the link is still refused, because the membership no longer holds.
    const late = (await createFeed(t.whoO, sc(t.uO), "ar")) as string;
    const lateBook = (await createBook(t.whoO, sc(t.uO), "calendly", "ar")) as string;
    expect(await resolveFeed(late)).not.toBeNull();
    expect(await live(late)).toBe(404);
    expect(await loginHolds((await resolveBook(lateBook))!)).toBe(false);
    expect(await live(h)).toBe(200);
    expect(await loginHolds((await resolveBook(bookH))!)).toBe(true);
  });

  it("booking: links in H and O per provider; revokeBook(O) leaves H's; status lists each account's own", async () => {
    const t = await twoAccounts();
    const [h, o, o2] = [
      (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string,
      (await createBook(t.whoO, sc(t.uO), "calcom", "en")) as string,
      (await createBook(t.whoO, sc(t.uO), "calendly", "en")) as string,
    ];
    for (const tok of [h, o, o2]) expect(await loginHolds((await resolveBook(tok))!)).toBe(true);
    expect(await db.get(BOOK_KEYS.of(t.email, "calcom"))).toBe(hashBookToken(h));
    expect(await db.get(BOOK_KEYS.of(t.email, "calendly"))).toBeNull();
    expect((await getBookStatus(t.whoO, sc(t.uO))).map((s) => s.provider).sort()).toEqual(["calcom", "calendly"]);
    expect((await getBookStatus(t.whoH, sc(t.uH))).map((s) => s.provider)).toEqual(["calcom"]);

    await revokeBook(t.whoO);
    expect(await resolveBook(o)).toBeNull();
    expect(await resolveBook(o2)).toBeNull();
    expect(await resolveBook(h)).not.toBeNull();
    expect(await getBookStatus(t.whoO, sc(t.uO))).toEqual([]);
  });
});

describe("rule 2132: R1 still reads the home link; links made before M1 keep working", () => {
  it("a home link is readable by an R1-shaped resolver: legacy pointer, record, and R1's check on the fields it knows", async () => {
    const t = await twoAccounts();
    const h = await routeFeed(t.email, t.H);
    // R1: `sec:feedof:{login}` names the hash, the record is there, and R1's check (no pid read) holds.
    const hash = await db.get<string>(FEED_KEYS.of(t.email));
    expect(hash).toBe(hashFeedToken(h));
    const rec = (await db.get<FeedRecord>(FEED_KEYS.rec(hash!)))!;
    const { pid: _p, aid: _a, home: _h, ...r1 } = rec;
    expect(await loginHolds(r1)).toBe(true);
    expect(Object.keys(r1).sort()).toEqual(["createdAt", "lang", "login", "scope"]);
  });

  it("a home link needs both pointers: a revoke by address (reset, console, R1) that drops only the legacy pointer ends it, and revokeFeed(login) drops the (pid, aid) pointer too", async () => {
    const t = await twoAccounts();
    const h = await routeFeed(t.email, t.H);
    await db.del(FEED_KEYS.of(t.email));
    expect(await resolveFeed(h)).toBeNull();
    expect((await getFeedStatus(t.whoH)).exists).toBe(false);

    const h2 = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    const o = (await createFeed(t.whoO, sc(t.uO), "ar")) as string;
    await revokeFeed(t.email);
    expect(await resolveFeed(h2)).toBeNull();
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBeNull();
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(h2)))).toBeNull();
    // The address names the home only: the link in O is not touched (it dies at read time with the person, rule 2131).
    expect(await live(o)).toBe(200);
  });

  it("a link made before M1 (no pid) still resolves, shows in the home status, is replaced by a new home link, and deleteMembership(home) revokes it", async () => {
    const t = await twoAccounts();
    const old = (await createFeed(t.email, sc(t.uH), "ar")) as string;
    const oldBook = (await createBook(t.email, sc(t.uH), "calcom", "ar")) as string;
    expect((await resolveFeed(old))!.rec.pid).toBeUndefined();
    expect(await live(old)).toBe(200);
    expect(await loginHolds((await resolveBook(oldBook))!)).toBe(true);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(true);
    expect((await getFeedStatus(t.whoO, sc(t.uO))).exists).toBe(false);
    expect((await getBookStatus(t.whoH)).map((s) => s.provider)).toEqual(["calcom"]);

    // A new home link replaces it (one link per person per account).
    const fresh = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    expect(await live(old)).toBe(404);
    expect(await live(fresh)).toBe(200);

    // A second pre-M1 link (an R1 build's create), then the home membership is deleted: both kinds end.
    const old2 = (await createFeed(t.email, sc(t.uH), "ar")) as string;
    expect(await live(old2)).toBe(200);
    const book2 = (await createBook(t.whoH, sc(t.uH), "calendly", "ar")) as string;
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calendly"))).toBe(hashBookToken(book2));
    await deleteMembership(aidOf(t.H), t.pid, { home: true, teamLocked: true });
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBeNull();
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calendly"))).toBeNull();
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calcom"))).toBeNull();
    expect(await resolveBook(book2)).toBeNull();
    expect(await resolveFeed(old2)).toBeNull();
    expect(await resolveBook(oldBook)).toBeNull();
    expect(await db.get(FEED_KEYS.of(t.email))).toBeNull();
    expect(await db.get(BOOK_KEYS.of(t.email, "calcom"))).toBeNull();
  });
});

describe("rule 2132: rollback and status", () => {
  it("R1 re-creates while an M1 home record exists: the M1 record is dead, the R1 link live, status shows the R1 link; a later M1 create cleans up", async () => {
    const t = await twoAccounts();
    const m1 = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    const m1Rec = (await resolveFeed(m1))!.rec;
    // R1's create: the per-login lock, a pid-less record, the legacy pointer, then the old record deleted.
    const r1 = (await createFeed(t.email, sc(t.uH), "en")) as string;
    expect(await resolveFeed(m1)).toBeNull();
    expect(await live(r1)).toBe(200);
    const r1Rec = (await resolveFeed(r1))!.rec;
    expect(r1Rec.pid).toBeUndefined();
    expect((await getFeedStatus(t.whoH, sc(t.uH))).createdAt).toBe(r1Rec.createdAt);
    // R1's delete of the M1 record failed: the record is back, named by the (pid, aid) pointer only, and still dead.
    await db.set(FEED_KEYS.rec(hashFeedToken(m1)), m1Rec);
    expect(await resolveFeed(m1)).toBeNull();
    expect(await live(m1)).toBe(404);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).createdAt).toBe(r1Rec.createdAt);
    // The next M1 create deletes both old records.
    const again = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(m1)))).toBeNull();
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(r1)))).toBeNull();
    expect(await live(again)).toBe(200);
  });

  it("status agrees with resolve when a home record is seen by an actor that is not home in it, for the feed and booking", async () => {
    const t = await twoAccounts();
    const f = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    const b = (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string;
    const flipped: LinkOwner = { ...t.whoH, home: false };
    expect(await resolveFeed(f)).not.toBeNull();
    expect((await getFeedStatus(flipped, sc(t.uH))).exists).toBe(true);
    expect((await getBookStatus(flipped, sc(t.uH))).map((r) => r.provider)).toEqual(["calcom"]);
    // With the legacy pointer gone the record is dead for resolve, and status says so too.
    await Promise.all([db.del(FEED_KEYS.of(t.email)), db.del(BOOK_KEYS.of(t.email, "calcom"))]);
    expect(await resolveFeed(f)).toBeNull();
    expect(await resolveBook(b)).toBeNull();
    expect((await getFeedStatus(flipped, sc(t.uH))).exists).toBe(false);
    expect(await getBookStatus(flipped, sc(t.uH))).toEqual([]);
  });

  it("a revoke by address deletes the home record's (pid, aid) pointer only while it still names that record", async () => {
    const t = await twoAccounts();
    const h = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    const b = (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string;
    const newer = "f".repeat(64);
    await Promise.all([db.set(personKey.feedOf(t.pid, aidOf(t.H)), newer), db.set(personKey.bookOf(t.pid, aidOf(t.H), "calcom"), newer)]);
    await Promise.all([revokeFeed(t.email), revokeBook(t.email)]);
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(h)))).toBeNull();
    expect(await db.get(BOOK_KEYS.rec(hashBookToken(b)))).toBeNull();
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBe(newer);
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calcom"))).toBe(newer);
  });
});

describe("rule 2131: suspensions", () => {
  it("a person suspension ends the links in every account", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    const b = (await createBook(t.whoO, sc(t.uO), "calcom", "ar")) as string;
    const { source: _s, ...person } = (await getPerson(t.pid))!;
    await db.set(personKey.person(t.pid), { ...person, suspended: true });
    expect(await live(h)).toBe(404);
    expect(await live(o)).toBe(404);
    expect(await loginHolds((await resolveBook(b))!)).toBe(false);
  });

  it("an account suspension ends only that account's links", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.O), await routeFeed(t.email, t.H)].reverse();
    const [bo, bh] = [(await createBook(t.whoO, sc(t.uO), "calcom", "ar")) as string, (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string];
    await saveUser({ ...t.O, suspended: true } as User);
    expect(await live(o)).toBe(404);
    expect(await live(h)).toBe(200);
    expect(await loginHolds((await resolveBook(bo))!)).toBe(false);
    expect(await loginHolds((await resolveBook(bh))!)).toBe(true);
  });

  it("a person suspension ends a feed link and a booking link made before M1 (no pid) too", async () => {
    const t = await twoAccounts();
    const f = (await createFeed(t.email, sc(t.uH), "ar")) as string;
    const b = (await createBook(t.email, sc(t.uH), "calcom", "ar")) as string;
    expect(await live(f)).toBe(200);
    expect(await loginHolds((await resolveBook(b))!)).toBe(true);
    const { source: _s, ...person } = (await getPerson(t.pid))!;
    await db.set(personKey.person(t.pid), { ...person, suspended: true });
    expect(await live(f)).toBe(404);
    expect(await loginHolds((await resolveBook(b))!)).toBe(false);
  });
});

describe("rule 2139: the feed and booking locks are leaves, new first and legacy inside", () => {
  it("the lock keys are byte-exact; a held legacy lock makes the home create busy and frees the new lock; a create in another account ignores it", async () => {
    const pid = storedPersonId(`x-${randomBytes(3).toString("hex")}@test.example`);
    const aid = storedAccountId("acct@test.example");
    expect(personKey.feedLock(pid, aid)).toBe(`lock:feed:${pid}:${aid}`);
    expect(personKey.bookLock(pid, aid, "calcom")).toBe(`lock:book:${pid}:${aid}:calcom`);
    expect(personKey.feedOf(pid, aid)).toBe(`sec:feedof:${pid}:${aid}`);
    expect(personKey.bookOf(pid, aid, "calendly")).toBe(`sec:bookof:${pid}:${aid}:calendly`);

    const t = await twoAccounts();
    const held = (await db.lockOwned(`lock:feed:${t.email}`, 10))!;
    expect(await createFeed(t.whoH, sc(t.uH), "ar")).toBe("busy");
    // The new lock was released on the way out: it can be taken now.
    const mine = await db.lockOwned(personKey.feedLock(t.pid, aidOf(t.H)), 10);
    expect(mine).toBeTruthy();
    await db.unlockOwned(personKey.feedLock(t.pid, aidOf(t.H)), mine!);
    expect(typeof (await createFeed(t.whoO, sc(t.uO), "ar"))).toBe("string");
    await db.unlockOwned(`lock:feed:${t.email}`, held);

    const bookHeld = (await db.lockOwned(`lock:book:${t.email}:calcom`, 10))!;
    expect(await createBook(t.whoH, sc(t.uH), "calcom", "ar")).toBe("busy");
    expect(await db.lockOwned(personKey.bookLock(t.pid, aidOf(t.H), "calcom"), 10)).toBeTruthy();
    await db.unlockOwned(`lock:book:${t.email}:calcom`, bookHeld);
  });

  it("one round each: resolveFeed reads the record then both pointers together; loginHolds for an M1 record reads person, account, membership and brands together", async () => {
    const t = await twoAccounts();
    const h = await routeFeed(t.email, t.H);
    const rec = (await resolveFeed(h))!.rec;
    const r = trackRounds();
    r.start();
    expect(await resolveFeed(h)).not.toBeNull();
    expect(r.rounds()).toBe(2);
    r.start();
    expect(await loginHolds(rec)).toBe(true);
    expect(r.rounds()).toBe(1);
    const t2 = (await createBook(t.whoO, sc(t.uO), "calcom", "ar")) as string;
    r.start();
    expect(await resolveBook(t2)).not.toBeNull();
    expect(r.rounds()).toBe(2);
    r.stop();
  });

  it("a malformed record (one id without the other) is dead; a LinkOwner never comes from the request", async () => {
    const t = await twoAccounts();
    const h = await routeFeed(t.email, t.O);
    const key = FEED_KEYS.rec(hashFeedToken(h));
    const rec = (await db.get<FeedRecord>(key))!;
    const { aid: _a, ...half } = rec;
    await db.set(key, half);
    expect(await resolveFeed(h)).toBeNull();
    expect(await loginHolds(half)).toBe(false);
    // linkOwner reads the session's actor and account only.
    const u = await as(t.email, t.O);
    const who: LinkOwner = linkOwner(u)!;
    expect(who.aid).toBe(aidOf(t.O));
    expect(who.pid).toBe(t.pid as PersonId);
  });
});
