import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUserUnverified, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { applyReferral, codeFor, ownerOf, referralStats, registerCode } from "@/lib/referral";
import { hasPendingCode } from "@/lib/verify-email";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let mailOk = true;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { mails.push({ to, subject, text }); return mailOk; },
}));

import * as change from "@/app/api/auth/verify/email/route";

let ipN = 0;
/** Never repeats within a run, and never meets the IPs of the other verify test files. */
const freshIp = () => { ipN++; return `198.51.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const move = (email: unknown, ip = freshIp()) => change.POST(json("/api/auth/verify/email", "POST", { email }, { "x-real-ip": ip }));
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
    const stored = (await getUser(u.email))!;
    delete stored.gatedSignup;
    await saveUser(stored);
    await signIn(u.email);
    const to = addr("new");
    const res = await move(to);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_allowed" });
    expect(await getUser(to)).toBeNull();
    expect(await getUser(u.email)).not.toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("refused after verification (rule 763)", async () => {
    const u = await newUser("ch");
    await signIn(u.email);
    const to = addr("new");
    expect((await move(to)).status).toBe(403);
    expect(await getUser(to)).toBeNull();
    expect(await getUser(u.email)).not.toBeNull();
  });

  it("refused without a session, to a member login, and for a member session", async () => {
    expect((await move(addr("x"))).status).toBe(401);
    const owner = await newUser("ch", { verified: false });
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await move(addr("x"))).status).toBe(403);
  });

  it("bad address is 400 and changes nothing", async () => {
    const u = await newUser("ch", { verified: false });
    await signIn(u.email);
    for (const bad of ["", "nope", "a@b", 12, null, "a b@c.de"]) {
      const res = await move(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "bad_email" });
    }
    expect(await getUser(u.email)).not.toBeNull();
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
    expect((await getUser(u.email))!.emailMoves).toBeUndefined();
    expect(mails).toHaveLength(0);
  });

  it("the same address (any case) is refused and nothing changes", async () => {
    const u = await newUser("ch", { verified: false });
    await signIn(u.email);
    const res = await move(u.email.toUpperCase());
    expect([400, 409]).toContain(res.status);
    expect(await getUser(u.email)).not.toBeNull();
  });

  it("moves the account (rule 764)", async () => {
    const referrer = await newUser("rf");
    await registerCode(referrer.email);
    const old = await newUser("ch", { verified: false });
    await registerCode(old.email);
    expect(await applyReferral(old.email, codeFor(referrer.email))).toBe(true);
    const partner = addr("partner");
    const stored = (await getUser(old.email))!;
    stored.referredBy = { partner, code: "PCODE1", at: new Date().toISOString(), via: "code", ref: "abc123def456" };
    stored.firstMonthOffer = { kind: "partner", pct: 15, at: new Date().toISOString() };
    await saveUser(stored);
    await db.sadd(`partner:refs:${partner}`, old.email);
    const before = (await getUser(old.email))!;
    expect(before.credits).toBeGreaterThan(0);
    const token = await signIn(old.email);

    const to = addr("fixed");
    const res = await move(`  ${to.toUpperCase()}  `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to });

    const after = (await getUser(to))!;
    expect(after).not.toBeNull();
    expect(after.email).toBe(to);
    for (const k of ["name", "phone", "passHash", "lang", "plan", "credits", "trialEnds", "createdAt", "sessionsAfter", "gatedSignup", "referredBy", "firstMonthOffer"] as const) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect(after.emailVerifiedAt).toBeUndefined();
    expect(after.emailMoves).toEqual({ day: new Date().toISOString().slice(0, 10), n: 1 });
    expect(await getUser(old.email)).toBeNull();
    expect(await db.get(`user:${old.email}`)).toBeNull();
    expect(await db.sismember("users:all", to)).toBe(true);
    expect(await db.sismember("users:all", old.email)).toBe(false);

    // The account's own referral code now names the new address.
    expect(await ownerOf(codeFor(to))).toBe(to);
    expect(await ownerOf(codeFor(old.email))).toBeNull();
    // The referral it came in with: the referrer sees the new address, once, and the pending bonus follows.
    expect(await db.get(`referredBy:${to}`)).toBe(referrer.email);
    expect(await db.get(`referredBy:${old.email}`)).toBeNull();
    const stats = await referralStats(referrer.email);
    expect(stats.rows.map((r) => r.email)).toEqual([to]);
    expect(stats.pending).toBe(1);
    expect(stats.count).toBe(1);
    // The partner attribution.
    const refs = await db.smembers(`partner:refs:${partner}`);
    expect(refs).toContain(to);
    expect(refs).not.toContain(old.email);

    // The cookie resolves to the new address; the old session token is dead; a code went to the new address only.
    expect((await currentUserUnverified())!.email).toBe(to);
    expect(await db.get(`session:${token}`)).toBeNull();
    jar().set("nashr_session", token);
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
    expect((await getUser(to))!.referredBy).toBeUndefined();
    expect(await getUser(old.email)).toBeNull();
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
      expect((await getUser(at))!.emailMoves!.n).toBe(i);
    }
    const res = await move(addr("m4"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await getUser(at)).not.toBeNull();
  });

  it("a counter from an earlier day starts over", async () => {
    const old = await newUser("ch", { verified: false });
    const stored = (await getUser(old.email))!;
    stored.emailMoves = { day: "2020-01-01", n: 3 };
    await saveUser(stored);
    await signIn(old.email);
    const to = addr("fixed");
    expect((await move(to)).status).toBe(200);
    expect((await getUser(to))!.emailMoves).toEqual({ day: new Date().toISOString().slice(0, 10), n: 1 });
  });

  it("a move whose mail cannot go out still moves the account (mail: false)", async () => {
    mailOk = false;
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to, mail: false });
    expect(await getUser(to)).not.toBeNull();
    expect((await currentUserUnverified())!.email).toBe(to);
    expect(await hasPendingCode(to)).toBe(false);
  });

  it("the send buckets answer 429 after the move", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    await db.incrby(`rate:verify:gap:${to}`, 5); // someone already used this address's one-a-minute send
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: to, mail: false });
    expect(mails).toHaveLength(0);
  });

  it("two moves at once from one account leave exactly one account", async () => {
    const referrer = await newUser("rf");
    await registerCode(referrer.email);
    const old = await newUser("ch", { verified: false });
    await registerCode(old.email);
    await applyReferral(old.email, codeFor(referrer.email));
    await signIn(old.email);
    const a = addr("a");
    const b = addr("b");
    const res = await Promise.all([move(a), move(b)]);
    const ok = res.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    const live = (await Promise.all([getUser(a), getUser(b), getUser(old.email)])).filter(Boolean) as User[];
    expect(live).toHaveLength(1);
    expect((await referralStats(referrer.email)).rows).toHaveLength(1);
  });

  it("finishes a move that stopped before the old account was wiped", async () => {
    const old = await newUser("ch", { verified: false });
    await signIn(old.email);
    const to = addr("fixed");
    // What a crash after the new record was written leaves behind: the copy exists, the old account too.
    await saveUser({ ...(await getUser(old.email))!, email: to, emailMoves: { day: new Date().toISOString().slice(0, 10), n: 1 } });
    const res = await move(to);
    expect(res.status).toBe(200);
    expect(await getUser(old.email)).toBeNull();
    expect((await getUser(to))!.emailMoves!.n).toBe(1);
  });
});
