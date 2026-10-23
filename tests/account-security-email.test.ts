import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { acct, createUser, currentUser, getLogin, getUser, saveUser, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMember, membersKey } from "@/lib/team";
import { mfaKey, mfaRecoveryHash } from "@/lib/mfa";
import { MIN_ROLE, IMPERSONATION_BLOCKED } from "@/lib/roles";
import { linkKey, subKey } from "@/lib/google-signin";
import { SEC_KEYS } from "@/lib/secretary";
import { layerKey } from "@/lib/instructions-store";
import { profileKey } from "@/lib/notify-prefs";
import { activityKey } from "@/lib/activity";
import { ownerHasData } from "@/lib/email-change";

// Release R2/M2 are on, so a test here runs as production does: an owner is a `p_` person owning an `a_` account and moves in
// place. The tests that pin R1's refusals (`owner_has_data`, the copy under a taken address, rules 1944-1945) ask for R1's
// shape with `r1()`: the flags read off for that test only, and the accounts it makes are address-keyed (the rollback floor, rule 3814).
const flags = vi.hoisted(() => ({ r1: false }));
vi.mock("@/lib/multi-org", async (orig) => { const m = await orig<typeof import("@/lib/multi-org")>(); return Object.defineProperty({ ...m }, "MULTI_ORG", { get: () => !flags.r1, enumerable: true }); });
vi.mock("@/lib/account-id", async (orig) => { const m = await orig<typeof import("@/lib/account-id")>(); return Object.defineProperty({ ...m }, "OPAQUE_IDS", { get: () => !flags.r1, enumerable: true }); });
const r1 = () => { flags.r1 = true; };

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { mails.push({ to, subject, text }); return true; },
}));

import * as emailRoute from "@/app/api/account/email/route";

/** Self-serve change of the sign-in address (rules 1942-1945, docs/system/tests/1930-account-security.md). */
const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `192.0.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}` }; };
const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const post = (body: Record<string, unknown>) => emailRoute.POST(json("/api/account/email", "POST", body, ip()));
const start = (email: string, password = "abc12345", mfaCode?: string) => post({ action: "start", email, password, ...(mfaCode ? { mfaCode } : {}) });
const confirm = (code: string) => post({ action: "confirm", code });
/** A customer recovery code (20 base32 characters): the proof the two-step login gives instead of a code from the app. */
const RECOVERY = "ABCDEFGHJKLMNPQRSTUV";
const codeFor = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/\d{6}/)![0];

beforeEach(() => {
  mails = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); flags.r1 = false; });

describe("rule 1942: the password starts it, the code goes to the new address only, nothing moves before the code", () => {
  it("an owner with an empty account moves to a proved address; the old address gets a notice", async () => {
    // Release R2: the owner is a `p_` person owning an `a_` account, and the move is in place (the account keeps its id).
    const u = await newUser("em");
    await signIn(u.email);
    const before = jar().get("thakeen_session")!;
    const to = addr("new");
    expect((await start(to, "wrong-pass")).status).toBe(401);
    const r = await start(to);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, pending: to });
    expect(mails.map((m) => m.to)).toEqual([to]);
    // Nothing moved yet: still the old login, and GET shows what waits.
    expect(await getLogin(to)).toBeNull();
    expect((await getLogin(u.email))?.acct).toBe(acct(u));
    expect((await (await emailRoute.GET()).json()).pending).toBe(to);
    const ok = await confirm(codeFor(to));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, email: to });
    const moved = (await getUser(acct(u)))!;
    expect(moved.email).toBe(to);
    expect((await getLogin(to))?.acct, "the account keeps its id; only the address moved").toBe(acct(u));
    expect(moved.emailVerifiedAt).toBeTruthy();
    expect(moved.createdAt).toBe(u.createdAt);
    expect(await getLogin(u.email)).toBeNull();
    // This device has a new session at the new address; the old cookie opens nothing.
    expect((await currentUser())?.email).toBe(to);
    jar().set("thakeen_session", before);
    expect(await currentUser()).toBeNull();
    const notice = mails.find((m) => m.to === u.email)!;
    expect(notice.text).toContain(to);
  });

  it("wrong codes are counted; the fifth drops the code; a right code works once", async () => {
    const u = await newUser("em");
    await signIn(u.email);
    const to = addr("new");
    await start(to);
    for (let i = 0; i < 4; i++) expect((await confirm("000000")).status).toBe(400);
    const last = await confirm("000000");
    expect(await last.json()).toMatchObject({ error: "locked" });
    expect((await confirm(codeFor(to))).status).toBe(400);
    expect(await getUser(to)).toBeNull();
  });
});

describe("rule 1943: a member moves its own login; the team, the active brand and two-step sign-in follow", () => {
  it("the member record, roster entry and enrolment move; the old login is gone", async () => {
    const owner = await newUser("em");
    // Pins the legacy shape (multi-org M1): an address moves only for a legacy person until release M2 moves it with the `p_` person.
    const m = await newMember(owner, "member", "m", { legacy: true });
    await db.set(`activebrand:${m.email}`, "default");
    await db.set(mfaKey(m.email), { enc: "x", kid: "k", rc: [mfaRecoveryHash(RECOVERY)], at: new Date().toISOString() });
    await Promise.all([db.set(subKey(m.email), "gMoveSub1"), db.set(linkKey("gMoveSub1"), m.email)]);
    await signIn(m.email);
    const before = jar().get("thakeen_session")!;
    const to = addr("mnew");
    // Release R2 (decision D2): a change on a login with two-step on asks its code; a recovery code is one.
    expect(await (await start(to, m.password)).json()).toMatchObject({ error: "mfa_required" });
    expect((await start(to, m.password, RECOVERY)).status).toBe(200);
    expect((await confirm(codeFor(to))).status).toBe(200);
    const moved = (await getMember(to))!;
    expect(moved).toMatchObject({ email: to, memberOf: acct(owner) });
    expect(await getMember(m.email)).toBeNull();
    const roster = await db.smembers(membersKey(acct(owner)));
    expect(roster).toContain(to);
    expect(roster).not.toContain(m.email);
    expect(await db.get(`activebrand:${to}`)).toBe("default");
    expect(await db.get(mfaKey(to))).toBeTruthy();
    // The Google link follows both ways; nothing names the old login.
    expect(await db.get(subKey(to))).toBe("gMoveSub1");
    expect(await db.get(linkKey("gMoveSub1"))).toBe(to);
    expect(await db.get(subKey(m.email))).toBeNull();
    const me = await currentUser();
    expect(me?.email).toBe(owner.email);
    expect(me?.actor).toMatchObject({ kind: "member", email: to });
    expect(await sessionRecord(before)).toBeTruthy();
    jar().set("thakeen_session", before);
    expect(await currentUser()).toBeNull();
  });
});

describe("rule 1944: an owner whose account holds work is sent to support; the typo fix keeps its own path", () => {
  it("owner_has_data for a brand record, a member or a paid plan, and no code is mailed", async () => {
    r1(); // Pins R1: the refusal exists only while `OPAQUE_IDS` is off (rule 2746); on, the owner moves in place with everything.
    const a = await newUser("em");
    await db.set(`brand:${a.email}`, { name: "x" });
    await signIn(a.email);
    expect(await (await start(addr("x"))).json()).toMatchObject({ error: "owner_has_data" });
    signOut();
    const b = await newUser("em");
    await newMember(b);
    await signIn(b.email);
    expect((await start(addr("x"))).status).toBe(409);
    signOut();
    const c = await newUser("em");
    const sc = (await getUser(c.email))!;
    sc.plan = "pro";
    await saveUser(sc);
    await signIn(c.email);
    expect((await start(addr("x"))).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("anything the owner made that the move would delete counts: Reem, instructions, settings, prefs, lists", async () => {
    const seeds: ((e: string) => Promise<unknown>)[] = [
      (e) => db.sadd(SEC_KEYS.all(e), "abcdef0123456789"),
      (e) => db.set(SEC_KEYS.cal(e), { days: [0, 1, 2, 3, 4] }),
      (e) => db.lpush(SEC_KEYS.notes(e), "{}"),
      (e) => db.set(layerKey(e), { rules: [] }),
      (e) => db.set(`gov:${e}`, { autopublish: false }),
      (e) => db.set(profileKey(e), { email: true }),
      (e) => db.lpush(activityKey(e), "{}"),
      (e) => db.lpush(`decisions:${e}`, "{}"),
      (e) => db.lpush(`handoffs:${e}`, "h1"),
    ];
    const refused = await Promise.all(seeds.map(async (seed) => {
      const u = await newUser("em");
      await seed(acct(u));
      return ownerHasData((await getUser(acct(u)))!);
    }));
    expect(refused).toEqual(seeds.map(() => true));
    // The daily run writes `schedule:` on an empty account by itself: that alone does not block the move.
    const quiet = await newUser("em");
    await db.set(`schedule:${acct(quiet)}`, { lastDaily: "2026-10-16" });
    expect(await ownerHasData((await getUser(acct(quiet)))!)).toBe(false);
  });

  it("work added between the code and the confirm still stops the move", async () => {
    r1(); // Pins R1, as above.
    const u = await newUser("em");
    await signIn(u.email);
    const to = addr("new");
    await start(to);
    await db.lpush(`tasks:${u.email}`, "t1");
    expect(await (await confirm(codeFor(to))).json()).toMatchObject({ error: "owner_has_data" });
    expect(await getUser(u.email)).toBeTruthy();
    expect(await getUser(to)).toBeNull();
  });

  it("moveUnverifiedAccount and the change share one core", () => {
    const src = read("src/lib/verify-email.ts");
    expect(src).toMatch(/export async function moveUnverifiedAccount[\s\S]*return moveOwnerLogin\(from, target, \{ may: gated, isCopy: gated \}\)/);
    expect(read("src/lib/email-change.ts")).toContain("moveOwnerLogin(u, to, {");
  });
});

describe("rule 1945: taken addresses, the account's own key and a founder impersonating are refused", () => {
  it("an address any login holds is refused, owner or member", async () => {
    const u = await newUser("em");
    const other = await newUser("em");
    const m = await newMember(other);
    await signIn(u.email);
    expect(await (await start(other.email)).json()).toMatchObject({ error: "taken" });
    expect(await (await start(m.email)).json()).toMatchObject({ error: "taken" });
    expect(await (await start(u.email)).json()).toMatchObject({ error: "same_email" });
    expect(await (await start("not-an-email")).json()).toMatchObject({ error: "invalid_email" });
  });

  it("an address taken between start and confirm is refused and nothing moves", async () => {
    r1(); // Pins R1's copy under a taken address (rule 1981's guarded fallback); the in-place race is the next test.
    // Pins the legacy shape (multi-org M1): an address moves only for a legacy person until release M2 moves it with the `p_` person.
    const u = await newUser("em", { legacy: true });
    await signIn(u.email);
    const to = addr("race");
    await start(to);
    // Pins the legacy shape (multi-org M1): the copy below is a legacy owner record (no `ownerPid`), found by rule 1981.
    const thief = await newUser("em", { legacy: true });
    const t = (await getUser(thief.email))!;
    // A copy at the address, stored under it (a record's key is its id, rule 1980); no login index, so the guarded
    // fallback of rule 1981 is what finds it.
    await saveUser({ ...t, id: to, email: to });
    expect(await (await confirm(codeFor(to))).json()).toMatchObject({ error: "taken" });
    expect(await getUser(u.email)).toBeTruthy();
  });

  it("release R2: an address taken between start and confirm is refused and the login stays where it was", async () => {
    const u = await newUser("em");
    await signIn(u.email);
    const to = addr("race2");
    await start(to);
    await createUser({ email: to, name: "Thief", phone: "", password: "abc12345", lang: "ar" });
    expect(await (await confirm(codeFor(to))).json()).toMatchObject({ error: "taken" });
    expect((await getLogin(u.email))?.acct).toBe(acct(u));
    expect((await getUser(acct(u)))!.email).toBe(u.email);
  });

  it("release R2: an owner whose account holds work moves in place with all of it (rule 2746)", async () => {
    const u = await newUser("em");
    await db.set(`brand:${acct(u)}`, { name: "x" });
    await db.lpush(`tasks:${acct(u)}`, "t1");
    await signIn(u.email);
    const to = addr("data");
    expect((await start(to)).status).toBe(200);
    expect((await confirm(codeFor(to))).status).toBe(200);
    expect(await db.get(`brand:${acct(u)}`)).toEqual({ name: "x" });
    expect((await getLogin(to))?.acct).toBe(acct(u));
    expect((await getUser(acct(u)))!.email).toBe(to);
  });

  it("the pending record is keyed by the session's login, never the request", () => {
    const src = read("src/lib/email-change.ts");
    expect(src).toMatch(/pendingKey\(me\.email\)/);
    expect(src).not.toMatch(/pendingKey\(to\)|pendingKey\(target\)/);
    const route = read("src/app/api/account/email/route.ts");
    expect(route).toMatch(/verifySendRefusal\(to, req\)/);
  });

  it("email.change is member level and impersonation-blocked", async () => {
    expect(MIN_ROLE["email.change"]).toBe("member");
    expect(IMPERSONATION_BLOCKED.has("email.change")).toBe(true);
    vi.stubEnv("ADMIN_EMAILS", "founder-em@test.example");
    const u = await newUser("em");
    await signIn(u.email, { imp: "founder-em@test.example" });
    expect((await start(addr("x"))).status).toBe(403);
  });

  it("the settings page offers the change instead of sending people to support", () => {
    const ui = read("src/components/app/settings/AccountSettings.tsx");
    expect(ui).not.toContain("contact support to change it");
    expect(ui).toContain("<EmailChange ");
  });
});
