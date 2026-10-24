import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { acct, claimLogin, createUser, currentUserUnverified, getLogin, getUser, saveUser, sessionRecord, type User } from "@/lib/auth";
import { ownerOf as personOf } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { db } from "@/lib/db";
import { applyReferral, codeFor, ownerOf, referralStats, registerCode } from "@/lib/referral";
import { hasPendingCode } from "@/lib/verify-email";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let mailOk = true;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => { const { to: to, subject: subject, text: text } = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as { to: string; subject: string; text: string }; mails.push({ to, subject, text }); return mailOk; },
}));

import * as change from "@/app/api/auth/verify/email/route";
import * as check from "@/app/api/auth/verify/check/route";

// Account-id R2 (rule 2741): with `OPAQUE_IDS` on the typo fix moves the owner's login IN PLACE. The account id, the person
// id, the referral and partner keys stay put; only the sign-in address (the login index, the record's `email`) follows.
// The account is read by `acct(u)`, the new address resolves to it through `getLogin(to)`.
/** When the owner's session window opened: a `p_` person keeps it on the person row, the account record carries it only after a move. */
const windowOf = async (u: User) => Date.parse((await getPerson(personOf(u)))!.sessionsAfter!);
const lookAlike = (to: string) => createUser({ email: to, name: "Test", phone: "", password: "abc12345", lang: "ar" });

let ipN = 0;
/** Never repeats within a run, and never meets the IPs of the other verify test files. */
const freshIp = () => { ipN++; return `198.51.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const move = (email: unknown, ip = freshIp()) => change.POST(json("/api/auth/verify/email", "POST", { email }, { "x-forwarded-for": ip }));
const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;

beforeEach(() => {
  mails = [];
  mailOk = true;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

/** Rules 763-765: an unverified gated owner moves the account to a corrected address. */
describe("change a mistyped signup email", () => {
  it("refused without gatedSignup (rule 763)", async () => {
    const u = await newUser("ch", { verified: false });
    const stored = (await getUser(acct(u)))!;
    delete stored.gatedSignup;
    await saveUser(stored);
    await signIn(u.email);
    const to = addr("new");
    const res = await move(to);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_allowed" });
    expect(await getLogin(to)).toBeNull();
    expect((await getUser(acct(u)))!.email).toBe(u.email);
    expect(mails).toHaveLength(0);
  });

  it("refused after verification (rule 763)", async () => {
    const u = await newUser("ch");
    await signIn(u.email);
    const to = addr("new");
    expect((await move(to)).status).toBe(403);
    expect(await getLogin(to)).toBeNull();
    expect((await getUser(acct(u)))!.email).toBe(u.email);
  });

  it("refused without a session, to a member login, and for a member session", async () => {
    expect((await move(addr("x"))).status).toBe(401);
    const owner = await newUser("ch");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await move(addr("x"))).status).toBe(403);
    // Rule 767: a member of an unverified owner reads as signed out here too.
    const pending = await newUser("ch", { verified: false });
    const m2 = await newMember(pending);
    await signIn(m2.email);
    expect((await move(addr("x"))).status).toBe(401);
  });

  it("bad address is 400 and changes nothing", async () => {
    const u = await newUser("ch", { verified: false });
    await signIn(u.email);
    for (const bad of ["", "nope", "a@b", 12, null, "a b@c.de"]) {
      const res = await move(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "bad_email" });
    }
    expect((await getUser(acct(u)))!.email).toBe(u.email);
  });

  it("refused to a taken owner address and to a member login address (409)", async () => {
    const u = await newUser("ch", { verified: false });
    const taken = await newUser("tk");
    const owner = await newUser("ow");
    const m = await newMember(owner);
    await signIn(u.email);
    for (const to of [taken.email, m.email.toUpperCase(), ` ${taken.email} `]) {
      const res = await move(to);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "exists" });
    }
    expect((await getUser(acct(u)))!.emailMoves).toBeUndefined();
    expect(mails).toHaveLength(0);
  });

  it("the same address (any case) is refused and nothing changes", async () => {
    const u = await newUser("ch", { verified: false });
    await signIn(u.email);
    const res = await move(u.email.toUpperCase());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "same_email" });
    expect((await getUser(acct(u)))!.email).toBe(u.email);
  });

  it("moves the account (rule 764)", async () => {
    const referrer = await newUser("rf");
    await registerCode(acct(referrer));
    const old = await newUser("ch", { verified: false });
    const id = acct(old);
    await registerCode(id);
    expect(await applyReferral(id, codeFor(acct(referrer)))).toBe(true);
    const partner = addr("partner");
    const stored = (await getUser(id))!;
    stored.referredBy = { partner, code: "PCODE1", at: new Date().toISOString(), via: "code", ref: "abc123def456" };
    stored.firstMonthOffer = { kind: "partner", pct: 15, at: new Date().toISOString() };
    await saveUser(stored);
    await db.sadd(`partner:refs:${partner}`, id);
    const before = (await getUser(id))!;
    const opened = await windowOf(old);
    expect(before.credits).toBeGreaterThan(0);
    const token = await signIn(old.email);

    const to = addr("fixed");
    const res = await move(`  ${to.toUpperCase()}  `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to });

    // In place: the same record under the same id, with the new sign-in address.
    const after = (await getUser(id))!;
    expect(after.id).toBe(id);
    expect(after.email).toBe(to);
    for (const k of ["name", "phone", "passHash", "lang", "plan", "credits", "trialEnds", "createdAt", "gatedSignup", "referredBy", "firstMonthOffer"] as const) {
      expect(after[k], k).toEqual(before[k]);
    }
    // A fresh session window, not the old one (as createUser stamps): see the session test below.
    expect(Date.parse(after.sessionsAfter!)).toBeGreaterThan(opened);
    expect((await getPerson(personOf(old)))!.sessionsAfter).toBe(after.sessionsAfter);
    expect(after.emailVerifiedAt).toBeUndefined();
    expect(after.emailMoves).toEqual({ day: new Date().toISOString().slice(0, 10), n: 1 });
    // The login index follows the address; the old address names nobody and nothing is copied or wiped.
    const login = (await getLogin(to))!;
    expect(login.acct).toBe(id);
    expect(login.pid).toBe(personOf(old));
    expect(await getLogin(old.email)).toBeNull();
    expect(await getUser(to)).toBeNull();
    expect(await db.get(`user:${to}`)).toBeNull();
    expect(await db.sismember("users:all", id)).toBe(true);
    expect(await db.sismember("users:all", to)).toBe(false);

    // The account's own referral code and the referral it came in with are keyed by the account id, which did not move.
    expect(await ownerOf(codeFor(id))).toBe(id);
    expect(await db.get(`referredBy:${id}`)).toBe(acct(referrer));
    const stats = await referralStats(acct(referrer));
    expect(stats.rows.map((r) => r.email)).toEqual([id]);
    expect(stats.pending).toBe(1);
    expect(stats.count).toBe(1);
    // The partner attribution stays on the account id.
    const refs = await db.smembers(`partner:refs:${partner}`);
    expect(refs).toEqual([id]);

    // The cookie resolves to the new address; the old session token is dead; a code went to the new address only.
    expect((await currentUserUnverified())!.email).toBe(to);
    expect(await sessionRecord(token)).toBeNull();
    jar().set("thakeen_session", token);
    expect(await currentUserUnverified()).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(to);
    expect(mails[0].text).toMatch(/\d{6}/);
    expect(await hasPendingCode(to)).toBe(true);
    expect(await hasPendingCode(old.email)).toBe(false);
  });

  it("drops the old address's pending code and counter", async () => {
    const old = await newUser("ch", { verified: false });
    await db.set(`verify:code:${old.email}`, { hash: "x", sentAt: 1 }, 900);
    await db.incrby(`verify:tries:${old.email}`, 2);
    await signIn(old.email);
    expect((await move(addr("fixed"))).status).toBe(200);
    expect(await db.get(`verify:code:${old.email}`)).toBeNull();
    expect(await db.ttl(`verify:tries:${old.email}`)).toBe(-2);
  });

  it("an account with no referral and no partner moves too", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("plain");
    expect((await move(to)).status).toBe(200);
    const moved = (await getUser(acct(old)))!;
    expect(moved.email).toBe(to);
    expect(moved.referredBy).toBeUndefined();
    expect(await getLogin(old.email)).toBeNull();
  });

  it("three moves a day, the fourth is 429 and the counter carries (rule 765)", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    let at = old.email;
    for (let i = 1; i <= 3; i++) {
      const to = addr(`m${i}`);
      const res = await move(to);
      expect(res.status, `move ${i}`).toBe(200);
      at = to;
      expect((await getUser(acct(old)))!.emailMoves!.n).toBe(i);
    }
    const res = await move(addr("m4"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(86400);
    expect((await getUser(acct(old)))!.email).toBe(at);
  });

  it("a counter from an earlier day starts over", async () => {
    const old = await newUser("ch", { verified: false });
    const stored = (await getUser(acct(old)))!;
    stored.emailMoves = { day: "2020-01-01", n: 3 };
    await saveUser(stored);
    await signIn(old.email);
    const to = addr("fixed");
    expect((await move(to)).status).toBe(200);
    expect((await getUser(acct(old)))!.emailMoves).toEqual({ day: new Date().toISOString().slice(0, 10), n: 1 });
  });

  it("a move whose mail cannot go out still moves the account (mail: false)", async () => {
    mailOk = false;
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to, mail: false });
    expect((await getLogin(to))!.acct).toBe(acct(old));
    expect((await getUser(acct(old)))!.email).toBe(to);
    expect((await currentUserUnverified())!.email).toBe(to);
    expect(await hasPendingCode(to)).toBe(false);
  });

  // Rule 766 on the change route: a test deploy hands the new address's code back, and it verifies; a production
  // deploy never does, even with APP_ENV=test.
  it("devCode only under APP_ENV=test off a production deploy, and it verifies", async () => {
    vi.stubEnv("APP_ENV", "test");
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("dev");
    const body = await (await move(to)).json();
    expect(body).toMatchObject({ ok: true, email: to });
    expect(body.devCode).toBe(mails.find((m) => m.to === to)!.text.match(/\d{6}/)![0]);
    const res = await check.POST(json("/api/auth/verify/check", "POST", { code: body.devCode }, { "x-forwarded-for": freshIp() }));
    expect(res.status).toBe(200);
    expect((await getUser(acct(old)))!.emailVerifiedAt).toBeTruthy();

    vi.stubEnv("VERCEL_ENV", "production");
    const old2 = await newUser("ch", { verified: false });
    await signIn(old2.email);
    const to2 = addr("prod");
    const prod = await (await move(to2)).json();
    expect(prod).toEqual({ ok: true, email: to2 });
    expect(prod.devCode).toBeUndefined();
  });

  it("a full send bucket after the move still answers 200 with mail: false", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    await db.incrby(`rate:verify:gap:${to}`, 5); // someone already used this address's one-a-minute send
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to, mail: false });
    expect(mails).toHaveLength(0);
  });

  it("two moves at once from one account leave exactly one address", async () => {
    const referrer = await newUser("rf");
    await registerCode(acct(referrer));
    const old = await newUser("ch", { verified: false });
    await registerCode(acct(old));
    await applyReferral(acct(old), codeFor(acct(referrer)));
    await signIn(old.email);
    const a = addr("a");
    const b = addr("b");
    const res = await Promise.all([move(a), move(b)]);
    const ok = res.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    // One login resolves to the account (the winner's), and the record names it.
    const live = (await Promise.all([getLogin(a), getLogin(b), getLogin(old.email)])).filter(Boolean);
    expect(live).toHaveLength(1);
    expect(live[0]!.acct).toBe(acct(old));
    expect([a, b]).toContain((await getUser(acct(old)))!.email);
    expect((await referralStats(acct(referrer))).rows).toHaveLength(1);
  });

  it("finishes a move that stopped before the old address was released", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    // What a crash right after the first write leaves behind: the new login already names this person, the old one too.
    await claimLogin(to, personOf(old));
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await getLogin(old.email)).toBeNull();
    expect((await getLogin(to))!.acct).toBe(acct(old));
    expect((await getUser(acct(old)))!.emailMoves!.n).toBe(1);
  });

  it("a session issued earlier for the target address never resolves to the moved account", async () => {
    const old = await newUser("ch", { verified: false });
    const to = addr("fixed");
    // What a former owner of the address, a removed member or this owner's own old device left behind.
    const stale = randomBytes(32).toString("hex");
    // Issued after the person's own window opened, so only the fresh stamp from the move can refuse it.
    await db.set(`session:${stale}`, { email: to, at: (await windowOf(old)) + 1 }, 3600);
    await new Promise((r) => setTimeout(r, 5));
    await signIn(old.email);
    expect((await move(to)).status).toBe(200);
    expect((await currentUserUnverified())!.email).toBe(to);
    jar().set("thakeen_session", stale);
    expect(await currentUserUnverified()).toBeNull();
  });

  it("the repair of a stopped move applies the same fresh session window", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    const opened = await windowOf(old);
    await claimLogin(to, personOf(old));
    const stale = randomBytes(32).toString("hex");
    // Issued after the person's own window opened, so only the fresh stamp from the move can refuse it.
    await db.set(`session:${stale}`, { email: to, at: opened + 1 }, 3600);
    await new Promise((r) => setTimeout(r, 5));
    expect((await move(to)).status).toBe(200);
    expect(Date.parse((await getUser(acct(old)))!.sessionsAfter!)).toBeGreaterThan(opened);
    expect((await currentUserUnverified())!.email).toBe(to);
    jar().set("thakeen_session", stale);
    expect(await currentUserUnverified()).toBeNull();
  });

  it("no repair for a look-alike: another login at the target with the same password is 409", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("taken");
    await lookAlike(to);
    const res = await move(to);
    expect(res.status).toBe(409);
    expect((await getUser(acct(old)))!.email).toBe(old.email);
    expect((await getLogin(to))!.acct).not.toBe(acct(old));
  });

  it("no repair for a verified login at the target: 409", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("taken");
    await createUser({ email: to, name: "Test", phone: "", password: "abc12345", lang: "ar", emailVerifiedAt: new Date().toISOString() });
    expect((await move(to)).status).toBe(409);
    expect((await getUser(acct(old)))!.email).toBe(old.email);
  });

  it("the 11th move attempt of an account in a day is 429, taken addresses included", async () => {
    const taken = await newUser("tk");
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    for (let i = 1; i <= 10; i++) expect((await move(taken.email)).status, `attempt ${i}`).toBe(409);
    const res = await move(taken.email);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(res.headers.get("Retry-After")).toBe("86400");
    expect((await getUser(acct(old)))!.email).toBe(old.email);
  });

  it("the 21st request from one IP in an hour is 429", async () => {
    const ip = freshIp();
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    for (let i = 0; i < 20; i++) expect((await move("nope", ip)).status).toBe(400);
    const res = await move("nope", ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("a founder impersonating the account cannot move it (403)", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email, { imp: "founder@test.example" });
    const to = addr("fixed");
    const res = await move(to);
    expect(res.status).toBe(403);
    expect(await getLogin(to)).toBeNull();
    expect((await getUser(acct(old)))!.email).toBe(old.email);
  });
});
