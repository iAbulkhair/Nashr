import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { acct, currentUser, getUser, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { aidOf, ownerOf } from "@/lib/membership";
import { loginHolds } from "@/lib/secretary-feed";
import { getMember } from "@/lib/team";
import * as sessionsRoute from "@/app/api/account/sessions/route";

/**
 * UI/UX phase 4, the phase 3 security review's follow-ups on "sign out other devices" (rules 1170-1171,
 * docs/system/tests/1170-uiux-phase4.md). Rule 1150 itself stays pinned in tests/uiux-phase3.test.ts.
 */
const read = (f: string) => readFileSync(f, "utf8");
const post = (password: string) => sessionsRoute.POST(json("/api/account/sessions", "POST", { password }));
afterEach(() => { vi.restoreAllMocks(); signOut(); });

describe("rule 1170: the limit counts wrong passwords only, and the feed and booking links stay", () => {
  it("ten wrong passwords lock the route for the hour; correct ones never spend the allowance", async () => {
    const u = await newUser("so4");
    await signIn(u.email);
    // Twelve correct tries in a row: all answer 200, none is counted.
    for (let i = 0; i < 12; i++) expect((await post("abc12345")).status, `try ${i}`).toBe(200);
    expect(Number((await db.get(`rate:signoutothers:${u.email}`)) ?? 0)).toBe(0);
    for (let i = 0; i < 10; i++) expect((await post("wrong-pass")).status).toBe(401);
    // Spent: refused before the password is even read, a correct one included.
    expect((await post("abc12345")).status).toBe(429);
  });

  it("rule 1183: parallel wrong passwords cannot slip past the cap; the hit is taken before the compare", async () => {
    const u = await newUser("so4");
    await signIn(u.email);
    // Fifteen at once (a stolen cookie guessing in parallel): a read-then-spend limit let all fifteen reach bcrypt.
    const codes = (await Promise.all(Array.from({ length: 15 }, () => post("wrong-pass")))).map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect((await post("abc12345")).status).toBe(429);
    const src = read("src/app/api/account/sessions/route.ts");
    expect(src.indexOf("await allow(bucket")).toBeGreaterThan(-1);
    expect(src.indexOf("await allow(bucket")).toBeLessThan(src.indexOf("ownPasswordMatches(u, b.password)"));
    expect(src.indexOf("ownPasswordMatches(u, b.password)")).toBeLessThan(src.indexOf("await giveBack(bucket)"));
    expect(read("src/lib/rate.ts")).not.toMatch(/export async function spent\(/);
  });

  it("rule 1183: giveBack never leaves a counter below zero", async () => {
    const { giveBack } = await import("@/lib/rate");
    await giveBack("so4-empty-bucket");
    expect(await db.get("rate:so4-empty-bucket")).toBeNull();
  });

  it("the owner's sign-out stamps devicesAfter, never sessionsAfter, so a feed or booking link made earlier still holds", async () => {
    // Pins the legacy person shape (multi-org M1): the stamps are read on the account record, `user:{id}`.
    const u = await newUser("so4", { legacy: true });
    const before = (await getUser(acct(u)))!.sessionsAfter;
    const rec = { login: u.email, scope: acct(u), createdAt: new Date().toISOString(), pid: ownerOf(u), aid: aidOf(u) }; // a link as M1 writes it: an opaque account has no login-only link
    await new Promise((r) => setTimeout(r, 5));
    await signIn(u.email);
    expect((await post("abc12345")).status).toBe(200);
    const after = (await getUser(acct(u)))!;
    expect(after.sessionsAfter).toBe(before);
    expect(after.devicesAfter).toBeTruthy();
    expect(new Date(after.devicesAfter!).getTime()).toBeGreaterThan(new Date(rec.createdAt).getTime());
    expect(await loginHolds(rec)).toBe(true);
  });

  it("a member's sign-out stamps the member's devicesAfter only; the member's links stay too", async () => {
    const owner = await newUser("so4");
    // Pins the legacy shape (multi-org M1): the stamps are read on the legacy `member:{email}` record.
    const m = await newMember(owner, "member", "m", { legacy: true });
    const rec = { login: m.email, scope: acct(owner), createdAt: new Date().toISOString(), pid: m.pid, aid: aidOf(owner) };
    await new Promise((r) => setTimeout(r, 5));
    const other = await signIn(m.email);
    await signIn(m.email);
    const sessionsAfter = (await getMember(m.email))!.sessionsAfter;
    expect((await post(m.password)).status).toBe(200);
    const mem = (await getMember(m.email))!;
    expect(mem.sessionsAfter).toBe(sessionsAfter);
    expect(mem.devicesAfter).toBeTruthy();
    expect(await loginHolds(rec)).toBe(true);
    jar().set("thakeen_session", other);
    expect(await currentUser()).toBeNull();
  });

  it("a record without devicesAfter signs nothing out (the expand reads old records as before)", async () => {
    const u = await newUser("so4");
    const t = await signIn(u.email);
    expect((await getUser(acct(u)))!.devicesAfter).toBeUndefined();
    jar().set("thakeen_session", t);
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("the route and the copy say what stays, and the feed check never reads the new stamp", () => {
    const src = read("src/app/api/account/sessions/route.ts");
    expect(src).toMatch(/await giveBack\(bucket\)/);
    expect(src).not.toMatch(/revokeSessions/);
    expect(src).toMatch(/the calendar feed and booking links/);
    expect(read("src/lib/secretary-feed.ts")).not.toMatch(/devicesAfter/);
    const ui = read("src/components/app/settings/SecuritySettings.tsx");
    expect(ui).toContain("the calendar feed and booking links are not affected");
    expect(ui).toContain("ولا رابط التقويم ولا روابط الحجز");
  });
});

describe("rule 1171: the new session is written before the old ones end", () => {
  it("when the stamp cannot be saved the device is still signed in", async () => {
    // Pins the legacy shape (multi-org M1): the failing write is the account record's, `user:{id}`.
    const u = await newUser("so4", { legacy: true });
    await signIn(u.email);
    const real = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation(((key: string, ...rest: unknown[]) => {
      if (key === `user:${acct(u)}`) return Promise.reject(new Error("store down"));
      return (real as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as typeof db.set);
    await expect(post("abc12345")).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await currentUser())?.email).toBe(u.email);
    expect((await getUser(acct(u)))!.devicesAfter).toBeUndefined();
  });

  it("on success the old session record is gone and only the new one holds", async () => {
    const u = await newUser("so4");
    const mine = await signIn(u.email);
    expect((await post("abc12345")).status).toBe(200);
    const now = jar().get("thakeen_session")!;
    expect(now).not.toBe(mine);
    expect(await sessionRecord(mine)).toBeNull();
    expect(await sessionRecord(now)).toBeTruthy();
  });

  it("rotateSession writes the new session before calling revoke", () => {
    const src = read("src/lib/auth.ts");
    const body = src.slice(src.indexOf("export async function rotateSession"), src.indexOf("export async function destroySession"));
    expect(body.indexOf("await createSession(email)")).toBeGreaterThan(-1);
    expect(body.indexOf("await createSession(email)")).toBeLessThan(body.indexOf("await revoke(stamp)"));
    expect(body.indexOf("await revoke(stamp)")).toBeLessThan(body.lastIndexOf("await dropSession(old)"));
  });
});
