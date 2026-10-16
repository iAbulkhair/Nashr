import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMember, membersKey } from "@/lib/team";
import { mfaKey } from "@/lib/mfa";
import { MIN_ROLE, IMPERSONATION_BLOCKED } from "@/lib/roles";

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
const start = (email: string, password = "abc12345") => post({ action: "start", email, password });
const confirm = (code: string) => post({ action: "confirm", code });
const codeFor = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/\d{6}/)![0];

beforeEach(() => {
  mails = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

describe("rule 1942: the password starts it, the code goes to the new address only, nothing moves before the code", () => {
  it("an owner with an empty account moves to a proved address; the old address gets a notice", async () => {
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
    expect(await getUser(to)).toBeNull();
    expect((await (await emailRoute.GET()).json()).pending).toBe(to);
    const ok = await confirm(codeFor(to));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, email: to });
    const moved = (await getUser(to))!;
    expect(moved.emailVerifiedAt).toBeTruthy();
    expect(moved.createdAt).toBe(u.createdAt);
    expect(await getUser(u.email)).toBeNull();
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
    const m = await newMember(owner);
    await db.set(`activebrand:${m.email}`, "default");
    await db.set(mfaKey(m.email), { enc: "x", kid: "k", rc: [], at: new Date().toISOString() });
    await signIn(m.email);
    const before = jar().get("thakeen_session")!;
    const to = addr("mnew");
    await start(to, m.password);
    expect((await confirm(codeFor(to))).status).toBe(200);
    const moved = (await getMember(to))!;
    expect(moved).toMatchObject({ email: to, memberOf: owner.email });
    expect(await getMember(m.email)).toBeNull();
    const roster = await db.smembers(membersKey(owner.email));
    expect(roster).toContain(to);
    expect(roster).not.toContain(m.email);
    expect(await db.get(`activebrand:${to}`)).toBe("default");
    expect(await db.get(mfaKey(to))).toBeTruthy();
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

  it("work added between the code and the confirm still stops the move", async () => {
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
    const u = await newUser("em");
    await signIn(u.email);
    const to = addr("race");
    await start(to);
    const thief = await newUser("em");
    const t = (await getUser(thief.email))!;
    await saveUser({ ...t, email: to });
    expect(await (await confirm(codeFor(to))).json()).toMatchObject({ error: "taken" });
    expect(await getUser(u.email)).toBeTruthy();
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
