import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { json, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, currentUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getPerson } from "@/lib/person";
import { deleteMembership, writeMembership } from "@/lib/team";
import { createFeed, FEED_KEYS, getFeedStatus, hashFeedToken, linksOfPerson, resolveFeed, revokeFeed, revokeFeeds, type FeedRecord, type LinkOwner } from "@/lib/feed-token";
import { BOOK_KEYS, createBook, getBookStatus, hashBookToken, resolveBook, revokeBook, revokeBooks, type BookRecord } from "@/lib/booking-token";
import { linkOwner, loginHolds } from "@/lib/secretary-feed";
import * as feedRoute from "@/app/api/secretary/feed/[token]/route";
import * as manageRoute from "@/app/api/secretary/feed/route";

// Legacy persons (pid = its address), so the address names the person in the assertions below; each still holds a shadow
// membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace (docs/specs/2026-10-18-multi-org.md section 9): the calendar feed and the booking links per (person,
 * account). Rules 2119 (a link lives in one account and dies with its membership, even when the revoke is skipped), 2131
 * (a person suspension ends every link, an account suspension only that account's), 2138 (M4 contract: the legacy
 * per-login pointers `sec:feedof:{login}` / `sec:bookof:{login}:{provider}` and locks are never read or written, and a
 * link made before M1, without `pid`, is dead; it replaced rule 2132's M1 expand pins) and 2139 (the feed and booking
 * locks are leaves).
 *
 * The person is a member of H (where it signs in first) and joins O with `writeMembership`, as release M2's accept does.
 * Links are made through the management route signed in to each account, or with the library and a `LinkOwner` built
 * from stored ids.
 */
const plainToken = () => randomBytes(32).toString("base64url");

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

/** A person who is a member of H (where it signs in first) and a member of O. */
async function twoAccounts() {
  const [H, O] = [await newUser("lh"), await newUser("lo")];
  const p = await newMember(H, "member", "lp");
  const pid = storedPersonId(p.email);
  await writeMembership(aidOf(O), pid, { aid: aidOf(O), pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: storedPersonId(O.email) }, { teamLocked: true });
  const [uH, uO] = [await as(p.email, H), await as(p.email, O)];
  signOut();
  return { H, O, email: p.email, pid, uH, uO, whoH: linkOwner(uH)!, whoO: linkOwner(uO)! };
}

describe("rule 2119: a link lives in one account", () => {
  it("links in H and O each resolve; each record names its own account and scope; a record moved to the other account's scope is refused", async () => {
    const t = await twoAccounts();
    expect(t.whoH).toEqual({ pid: t.pid, aid: aidOf(t.H), login: t.email });
    expect(t.whoO).toEqual({ pid: t.pid, aid: aidOf(t.O), login: t.email });
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    expect(await live(h)).toBe(200);
    expect(await live(o)).toBe(200);

    const [recH, recO] = [(await resolveFeed(h))!.rec, (await resolveFeed(o))!.rec];
    expect(recH).toMatchObject({ pid: t.pid, aid: aidOf(t.H), scope: sc(t.uH), login: t.email });
    expect(recO).toMatchObject({ pid: t.pid, aid: aidOf(t.O), scope: sc(t.uO), login: t.email });
    expect(recH.home).toBeUndefined();
    expect(recO.home).toBeUndefined();
    // Each account's pointer names its own link; no legacy per-login pointer is written (rule 2138).
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBe(hashFeedToken(h));
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.O)))).toBe(hashFeedToken(o));
    expect(await db.get(FEED_KEYS.of(t.email))).toBeNull();

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

    await deleteMembership(aidOf(t.O), t.pid, { teamLocked: true });
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
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calcom"))).toBe(hashBookToken(h));
    expect(await db.get(BOOK_KEYS.of(t.email, "calcom"))).toBeNull();
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

describe("rule 2138: M4 contract, the legacy per-login pointers are gone and links made before M1 are dead", () => {
  it("a create writes no legacy pointer; a planted legacy pointer is never read: it neither keeps a link alive nor ends one", async () => {
    const t = await twoAccounts();
    const h = await routeFeed(t.email, t.H);
    const b = (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string;
    expect(await db.get(FEED_KEYS.of(t.email))).toBeNull();
    expect(await db.get(BOOK_KEYS.of(t.email, "calcom"))).toBeNull();
    // The record still carries `login` (the rate bucket's name; an M3 build after a rollback reads it).
    expect((await resolveFeed(h))!.rec.login).toBe(t.email);

    // A legacy pointer naming another hash changes nothing: the (pid, aid) pointer alone decides.
    await Promise.all([db.set(FEED_KEYS.of(t.email), "e".repeat(64)), db.set(BOOK_KEYS.of(t.email, "calcom"), "e".repeat(64))]);
    expect(await live(h)).toBe(200);
    expect(await resolveBook(b)).not.toBeNull();
    // Without the (pid, aid) pointer the link is dead, even when a legacy pointer names it.
    await Promise.all([db.set(FEED_KEYS.of(t.email), hashFeedToken(h)), db.set(BOOK_KEYS.of(t.email, "calcom"), hashBookToken(b))]);
    await Promise.all([db.del(personKey.feedOf(t.pid, aidOf(t.H))), db.del(personKey.bookOf(t.pid, aidOf(t.H), "calcom"))]);
    expect(await resolveFeed(h)).toBeNull();
    expect(await resolveBook(b)).toBeNull();
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(false);
    expect(await getBookStatus(t.whoH, sc(t.uH))).toEqual([]);
  });

  it("a link made before M1 (a record without pid, named by the legacy pointer) is dead: resolve, status and loginHolds refuse it", async () => {
    const t = await twoAccounts();
    const [f, b] = [plainToken(), plainToken()];
    const createdAt = new Date().toISOString();
    const feedRec: FeedRecord = { login: t.email, scope: sc(t.uH), lang: "ar", createdAt };
    const bookRec: BookRecord = { login: t.email, scope: sc(t.uH), provider: "calcom", lang: "ar", createdAt };
    await Promise.all([
      db.set(FEED_KEYS.rec(hashFeedToken(f)), feedRec),
      db.set(FEED_KEYS.of(t.email), hashFeedToken(f)),
      db.set(BOOK_KEYS.rec(hashBookToken(b)), bookRec),
      db.set(BOOK_KEYS.of(t.email, "calcom"), hashBookToken(b)),
    ]);
    expect(await resolveFeed(f)).toBeNull();
    expect(await live(f)).toBe(404);
    expect(await resolveBook(b)).toBeNull();
    expect(await loginHolds(feedRec)).toBe(false);
    expect(await loginHolds(bookRec)).toBe(false);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(false);
    expect(await getBookStatus(t.whoH, sc(t.uH))).toEqual([]);
    // Even a (pid, aid) pointer naming it does not revive it: the record names no ids.
    await db.set(personKey.feedOf(t.pid, aidOf(t.H)), hashFeedToken(f));
    expect(await resolveFeed(f)).toBeNull();
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(false);
    // A new link in H is made beside it as usual and is live.
    const fresh = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    expect(await live(fresh)).toBe(200);
  });

  it("a record M1 to M3 made with `home: true` stays live while its (pid, aid) pointer names it; revokeFeed / revokeBook end it", async () => {
    const t = await twoAccounts();
    const f = (await createFeed(t.whoH, sc(t.uH), "ar")) as string;
    const b = (await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string;
    const [fk, bk] = [FEED_KEYS.rec(hashFeedToken(f)), BOOK_KEYS.rec(hashBookToken(b))];
    await Promise.all([
      db.set(fk, { ...(await db.get<FeedRecord>(fk))!, home: true }),
      db.set(bk, { ...(await db.get<BookRecord>(bk))!, home: true }),
    ]);
    expect(await live(f)).toBe(200);
    expect(await loginHolds((await resolveBook(b))!)).toBe(true);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(true);
    await Promise.all([revokeFeed(t.whoH), revokeBook(t.whoH)]);
    expect(await live(f)).toBe(404);
    expect(await resolveBook(b)).toBeNull();
    expect(await db.get(fk)).toBeNull();
    expect(await db.get(bk)).toBeNull();
  });

  it("status agrees with resolve: a record its (pid, aid) pointer names but that names another person or account is dead for both", async () => {
    const t = await twoAccounts();
    const f = (await createFeed(t.whoO, sc(t.uO), "ar")) as string;
    const b = (await createBook(t.whoO, sc(t.uO), "calcom", "ar")) as string;
    // H's pointers name O's records: H's status shows nothing, and the records stay live only under O.
    await Promise.all([db.set(personKey.feedOf(t.pid, aidOf(t.H)), hashFeedToken(f)), db.set(personKey.bookOf(t.pid, aidOf(t.H), "calcom"), hashBookToken(b))]);
    expect((await getFeedStatus(t.whoH, sc(t.uH))).exists).toBe(false);
    expect(await getBookStatus(t.whoH, sc(t.uH))).toEqual([]);
    expect((await getFeedStatus(t.whoO, sc(t.uO))).exists).toBe(true);
    expect(await live(f)).toBe(200);
  });

  it("deleteMembership in the account the person signs in to first revokes its links there and leaves the other account's", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    const [bh, bh2] = [(await createBook(t.whoH, sc(t.uH), "calcom", "ar")) as string, (await createBook(t.whoH, sc(t.uH), "calendly", "ar")) as string];
    await deleteMembership(aidOf(t.H), t.pid, { teamLocked: true });
    expect(await live(h)).toBe(404);
    expect(await resolveBook(bh)).toBeNull();
    expect(await resolveBook(bh2)).toBeNull();
    expect(await db.get(personKey.feedOf(t.pid, aidOf(t.H)))).toBeNull();
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calcom"))).toBeNull();
    expect(await db.get(personKey.bookOf(t.pid, aidOf(t.H), "calendly"))).toBeNull();
    expect(await live(o)).toBe(200);
  });

  it("linksOfPerson names every account the person holds, so a person-wide revoke ends the links in each", async () => {
    const t = await twoAccounts();
    const [h, o] = [await routeFeed(t.email, t.H), await routeFeed(t.email, t.O)];
    const links = await linksOfPerson(t.pid);
    expect(links.map((l) => l.aid).sort()).toEqual(expect.arrayContaining([aidOf(t.H), aidOf(t.O)].sort()));
    expect(links.every((l) => l.pid === t.pid)).toBe(true);
    await Promise.all([revokeFeeds(links), revokeBooks(links)]);
    expect(await live(h)).toBe(404);
    expect(await live(o)).toBe(404);
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

});

describe("rule 2139: the feed and booking locks are leaves", () => {
  it("the lock keys are byte-exact; a held (pid, aid) lock makes that create busy; a held legacy per-login lock is ignored (rule 2138)", async () => {
    const pid = storedPersonId(`x-${randomBytes(3).toString("hex")}@test.example`);
    const aid = storedAccountId("acct@test.example");
    expect(personKey.feedLock(pid, aid)).toBe(`lock:feed:${pid}:${aid}`);
    expect(personKey.bookLock(pid, aid, "calcom")).toBe(`lock:book:${pid}:${aid}:calcom`);
    expect(personKey.feedOf(pid, aid)).toBe(`sec:feedof:${pid}:${aid}`);
    expect(personKey.bookOf(pid, aid, "calendly")).toBe(`sec:bookof:${pid}:${aid}:calendly`);

    const t = await twoAccounts();
    // The legacy per-login locks are never taken from M4: holding them blocks nothing.
    const legacyFeed = (await db.lockOwned(`lock:feed:${t.email}`, 10))!;
    const legacyBook = (await db.lockOwned(`lock:book:${t.email}:calcom`, 10))!;
    expect(typeof (await createFeed(t.whoH, sc(t.uH), "ar"))).toBe("string");
    expect(typeof (await createBook(t.whoH, sc(t.uH), "calcom", "ar"))).toBe("string");
    await Promise.all([db.unlockOwned(`lock:feed:${t.email}`, legacyFeed), db.unlockOwned(`lock:book:${t.email}:calcom`, legacyBook)]);

    // The (pid, aid) lock makes that create busy and leaves the other account's alone.
    const held = (await db.lockOwned(personKey.feedLock(t.pid, aidOf(t.H)), 10))!;
    expect(await createFeed(t.whoH, sc(t.uH), "ar")).toBe("busy");
    expect(typeof (await createFeed(t.whoO, sc(t.uO), "ar"))).toBe("string");
    await db.unlockOwned(personKey.feedLock(t.pid, aidOf(t.H)), held);
    const bookHeld = (await db.lockOwned(personKey.bookLock(t.pid, aidOf(t.H), "calcom"), 10))!;
    expect(await createBook(t.whoH, sc(t.uH), "calcom", "ar")).toBe("busy");
    await db.unlockOwned(personKey.bookLock(t.pid, aidOf(t.H), "calcom"), bookHeld);
  });

  it("rounds: resolveFeed reads the record then its (pid, aid) pointer; loginHolds reads person, account, membership and brands together", async () => {
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
