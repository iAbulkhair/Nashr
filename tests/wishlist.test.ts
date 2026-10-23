import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, markVerified, newUser, signIn, signOut } from "./helpers/session";
import { acct, createUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { wipeAccount } from "@/lib/account";
import { CHANGELOG, SEED_WISHES, SUGGESTION_MAX } from "@/lib/changelog";
import { WISH_KEYS, cleanText, listSuggestions, listWishes } from "@/lib/wishlist";
import * as vote from "@/app/api/wishlist/vote/route";
import * as suggest from "@/app/api/wishlist/suggest/route";
import * as admin from "@/app/api/admin/wishlist/route";

// Rules 149-155 in docs/system/tests.md: the public Updates & wishlist page (/{lang}/updates).

const FOUNDER = "wishfounder@test.example";
let founder: User;
const ITEM = SEED_WISHES[0].id;

const castVote = (body: unknown) => vote.POST(json("/api/wishlist/vote", "POST", body));
const sendSuggestion = (body: unknown) => suggest.POST(json("/api/wishlist/suggest", "POST", body));
const adminPost = (body: unknown) => admin.POST(json("/api/admin/wishlist", "POST", body));
const count = async (id: string) => (await listWishes(null, { includeHidden: true })).find((w) => w.id === id)?.votes;

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  founder = await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" });
  founder = await markVerified(FOUNDER);
});
afterEach(() => vi.restoreAllMocks());

describe("voting (rule 149)", () => {
  it("needs a signed-in account, and an anonymous request stores nothing", async () => {
    signOut();
    const before = await count(ITEM);
    const r = await castVote({ id: ITEM, on: true });
    expect(r.status).toBe(401);
    expect(await count(ITEM)).toBe(before);
  });

  it("counts one vote per account: repeating on:true changes nothing, on:false takes it back, no `on` toggles", async () => {
    const a = await newUser("voter"), b = await newUser("voter");
    const id = SEED_WISHES[1].id;
    await signIn(a.email);
    expect(await (await castVote({ id, on: true })).json()).toMatchObject({ ok: true, voted: true, votes: 1 });
    expect(await (await castVote({ id, on: true })).json()).toMatchObject({ ok: true, voted: true, votes: 1 });
    await signIn(b.email);
    expect(await (await castVote({ id, on: true })).json()).toMatchObject({ voted: true, votes: 2 });
    expect(await (await castVote({ id })).json()).toMatchObject({ voted: false, votes: 1 }); // toggle off
    expect(await (await castVote({ id })).json()).toMatchObject({ voted: true, votes: 2 }); // toggle on
    await signIn(a.email);
    expect(await (await castVote({ id, on: false })).json()).toMatchObject({ voted: false, votes: 1 });
    expect(await (await castVote({ id, on: false })).json()).toMatchObject({ voted: false, votes: 1 });
    const seenByB = (await listWishes(acct(b))).find((w) => w.id === id)!;
    const seenByA = (await listWishes(acct(a))).find((w) => w.id === id)!;
    expect([seenByB.voted, seenByA.voted, seenByA.votes]).toEqual([true, false, 1]);
  });

  it("refuses an id that is not a known item, before any key is built", async () => {
    const u = await newUser("voter");
    await signIn(u.email);
    const sadd = vi.spyOn(db, "sadd");
    for (const id of ["nope", "../x", "wish:mine:x", "__proto__", "constructor", "A-UPPER", "x".repeat(41), 42, null, undefined, { id: ITEM }]) {
      const r = await castVote({ id, on: true });
      expect(r.status, String(id)).toBe(400);
      expect((await r.json()).error).toBe("unknown_item");
    }
    expect(sadd).not.toHaveBeenCalled();
  });

  it("votes as the session's account only: an email, user or scope in the body is ignored", async () => {
    const me = await newUser("voter"), other = await newUser("victim");
    await signIn(me.email);
    const id = SEED_WISHES[2].id;
    await castVote({ id, on: true, email: other.email, user: other.email, scope: other.email, voter: other.email });
    expect(await db.smembers(WISH_KEYS.votes(id))).toEqual([acct(me)]);
    expect(await db.smembers(WISH_KEYS.mine(acct(other)))).toEqual([]);
    // And the other account's vote cannot be removed through the body either.
    await signIn(other.email);
    await castVote({ id: SEED_WISHES[3].id, on: true });
    await signIn(me.email);
    await castVote({ id: SEED_WISHES[3].id, on: false, email: other.email });
    expect(await db.smembers(WISH_KEYS.votes(SEED_WISHES[3].id))).toEqual([acct(other)]);
  });

  it("is rate limited per account", async () => {
    const u = await newUser("voter");
    await signIn(u.email);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await castVote({ id: ITEM })).status;
    expect(last).toBe(429);
  });
});

describe("suggestions (rule 150)", () => {
  it("need a signed-in account", async () => {
    signOut();
    const before = (await listSuggestions()).length;
    expect((await sendSuggestion({ text: "Schedule posts for Ramadan nights" })).status).toBe(401);
    expect((await listSuggestions()).length).toBe(before);
  });

  it("are bounded and stored as one clean line", async () => {
    const u = await newUser("sugg");
    await signIn(u.email);
    expect((await sendSuggestion({ text: "  hi \n" })).status).toBe(400);
    expect((await sendSuggestion({ text: "a".repeat(SUGGESTION_MAX + 1) })).status).toBe(400);
    expect((await sendSuggestion({ text: { nested: "object" } })).status).toBe(400);
    const r = await sendSuggestion({ text: "Line one\n\u0007Line‮ two​\tend", email: "someone@else.example" });
    expect(r.status).toBe(200);
    const mine = (await listSuggestions()).filter((s) => s.email === u.email);
    expect(mine.map((s) => s.text)).toEqual(["Line one Line two end"]);
    expect(cleanText("a\u0000b⁦c")).toBe("a bc");
  });

  it("are never on the public list: only the founder console reads the queue", async () => {
    const u = await newUser("sugg");
    await signIn(u.email);
    const secret = `Private idea ${Date.now()}`;
    expect((await sendSuggestion({ text: secret })).status).toBe(200);
    expect(JSON.stringify(await listWishes(acct(u)))).not.toContain(secret);
    expect(JSON.stringify(await listWishes(null))).not.toContain(secret);
    expect((await admin.GET(json("/api/admin/wishlist", "GET"))).status).toBe(401);
    // The public page reads items through listWishes and nothing else from the wishlist store.
    const page = readFileSync("src/app/[lang]/updates/page.tsx", "utf8");
    expect(page).not.toMatch(/listSuggestions|wish:suggestions|WISH_KEYS/);
  });

  it("are limited to five a day per account", async () => {
    const u = await newUser("sugg");
    await signIn(u.email);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await sendSuggestion({ text: `Idea number ${i} for the team` })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("founder console wishlist routes (rule 151)", () => {
  it("refuse anonymous callers and customers, and nothing changes", async () => {
    const customer = await newUser("customer");
    for (const who of [null, customer.email]) {
      if (who) await signIn(who); else signOut();
      expect((await admin.GET(json("/api/admin/wishlist", "GET"))).status).toBe(401);
      for (const body of [{ action: "promote", title: { ar: "أ", en: "A" } }, { action: "status", id: ITEM, status: "shipped" }, { action: "delete", id: ITEM }]) {
        expect((await adminPost(body)).status).toBe(401);
      }
    }
    const item = (await listWishes(null)).find((w) => w.id === ITEM)!;
    expect(item.status).toBe("planned");
    expect(item.hidden).toBe(false);
  });

  it("promote makes a suggestion public under the founder's title and removes it from the queue", async () => {
    const u = await newUser("sugg");
    await signIn(u.email);
    await sendSuggestion({ text: "please add a reels planner" });
    const s = (await listSuggestions()).find((x) => x.email === u.email)!;

    await signIn(founder.email);
    expect((await adminPost({ action: "promote", title: { ar: "", en: "Reels planner" } })).status).toBe(400);
    const r = await adminPost({ action: "promote", title: { ar: "مخطط الريلز", en: "Reels planner" }, area: "content", suggestionId: s.id });
    const { item } = await r.json();
    expect(item.id).toMatch(/^w-[0-9a-f]{8}$/);
    expect((await listSuggestions()).some((x) => x.id === s.id)).toBe(false);

    const pub = (await listWishes(null)).find((w) => w.id === item.id)!;
    expect(pub).toMatchObject({ title: { ar: "مخطط الريلز", en: "Reels planner" }, area: "content", status: "planned", votes: 0, seeded: false });

    // Anyone signed in can now vote on it; deleting it removes it and its votes.
    await signIn(u.email);
    expect(await (await castVote({ id: item.id, on: true })).json()).toMatchObject({ votes: 1 });
    await signIn(founder.email);
    expect((await adminPost({ action: "delete", id: item.id })).status).toBe(200);
    expect((await listWishes(null, { includeHidden: true })).some((w) => w.id === item.id)).toBe(false);
    expect(await db.smembers(WISH_KEYS.votes(item.id))).toEqual([]);
    await signIn(u.email);
    expect((await castVote({ id: item.id, on: true })).status).toBe(400);
  });

  it("sets a status, hides and restores a seeded item, and dismisses a suggestion", async () => {
    const id = SEED_WISHES[5].id;
    await signIn(founder.email);
    expect((await adminPost({ action: "status", id, status: "done" })).status).toBe(400);
    expect((await adminPost({ action: "status", id: "unknown-id", status: "shipped" })).status).toBe(400);
    expect((await adminPost({ action: "status", id, status: "in_progress" })).status).toBe(200);
    expect((await listWishes(null))[0]).toMatchObject({ id, status: "in_progress" }); // open work is listed first

    expect((await adminPost({ action: "delete", id })).status).toBe(200);
    expect((await listWishes(null)).some((w) => w.id === id)).toBe(false);
    const voter = await newUser("voter");
    await signIn(voter.email);
    expect((await castVote({ id, on: true })).status).toBe(400); // hidden items take no votes
    await signIn(founder.email);
    expect((await adminPost({ action: "restore", id })).status).toBe(200);
    expect((await listWishes(null)).some((w) => w.id === id)).toBe(true);

    const u = await newUser("sugg");
    await signIn(u.email);
    await sendSuggestion({ text: "an idea to dismiss" });
    const s = (await listSuggestions()).find((x) => x.email === u.email)!;
    await signIn(founder.email);
    expect((await adminPost({ action: "dismiss", suggestionId: s.id })).status).toBe(200);
    expect((await adminPost({ action: "dismiss", suggestionId: s.id })).status).toBe(400);
    expect((await adminPost({ action: "unknown" })).status).toBe(400);
  });
});

describe("reads are batched (rule 152)", () => {
  it("every count comes from one pipelined call, whatever the number of items", async () => {
    const u = await newUser("reader");
    const spies = { scardMany: vi.spyOn(db, "scardMany"), smembers: vi.spyOn(db, "smembers"), hgetall: vi.spyOn(db, "hgetall"), get: vi.spyOn(db, "get") };
    const list = await listWishes(acct(u));
    expect(list.length).toBeGreaterThanOrEqual(SEED_WISHES.length - 1);
    expect(spies.scardMany).toHaveBeenCalledTimes(1);
    expect(spies.scardMany.mock.calls[0][0]).toHaveLength(list.length);
    // hidden, mine, items and status: four reads side by side, none per item.
    expect(spies.smembers.mock.calls.length + spies.hgetall.mock.calls.length + spies.get.mock.calls.length).toBe(4);
  });
});

describe("account deletion (rule 153)", () => {
  it("takes the account's votes back and drops its suggestions", async () => {
    const u = await newUser("leaver");
    await signIn(u.email);
    const id = SEED_WISHES[7].id;
    const before = (await count(id))!;
    await castVote({ id, on: true });
    await sendSuggestion({ text: "an idea from a leaving account" });
    expect(await count(id)).toBe(before + 1);
    await wipeAccount(acct(u));
    expect(await count(id)).toBe(before);
    expect((await listSuggestions()).some((s) => s.email === u.email)).toBe(false);
    expect(await db.smembers(WISH_KEYS.mine(acct(u)))).toEqual([]);
  });
});

describe("page content (rule 154)", () => {
  it("dates every changelog entry, newest first, and names no competitor", () => {
    for (const e of CHANGELOG) expect(e.date).toMatch(/^2026-\d\d-\d\d$/);
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const text = readFileSync("src/lib/changelog.ts", "utf8");
    for (const name of ["Enrich", "Sintra", "Okara", "Jasper", "Adly", "هلا", "بي ترند", "betrend", "Store Tools", "لهجتي", "بوابة التميز", "صيت"]) expect(text, name).not.toContain(name);
  });

  it("seeds every wish with a unique, well-formed id and no votes", async () => {
    const ids = SEED_WISHES.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    const fresh = await listWishes(null);
    // No vote numbers are shipped in code: a seeded item nobody voted for shows 0.
    expect(fresh.find((w) => w.id === SEED_WISHES[SEED_WISHES.length - 1].id)!.votes).toBe(0);
    expect(SEED_WISHES.every((w) => !("votes" in w))).toBe(true);
  });
});
