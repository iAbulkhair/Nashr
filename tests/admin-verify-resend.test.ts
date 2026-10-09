import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, params, signIn, signOut } from "./helpers/session";
import { adminConsoleSrc } from "./helpers/admin-console";
import { db } from "@/lib/db";
import { hasPendingCode } from "@/lib/verify-email";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let mailOk = true;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { mails.push({ to, subject, text }); return mailOk; },
}));

import * as plan from "@/app/api/admin/plan/route";
import * as users from "@/app/api/admin/users/[email]/route";

const KEY = "test-admin-key-0123456789";
const asKey = { "x-admin-key": KEY };
const resend = (email: string, headers: Record<string, string> = asKey) =>
  users.POST(json("/api/admin/users/x", "POST", { action: "resendVerification" }, headers), params({ email: encodeURIComponent(email) }));
const lastLog = async () => JSON.parse(((await db.lrange("admin:log", 0, 0)) as string[])[0]);

beforeEach(() => {
  mails = [];
  mailOk = true;
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

/** Rule 776: the console list says which owners have not proved their address. */
describe("founder console: verified state", () => {
  it("the user list carries emailVerifiedAt, null until the owner verifies", async () => {
    const [open, done] = await Promise.all([newUser("av", { verified: false }), newUser("av")]);
    const body = await (await plan.GET(json("/api/admin/plan", "GET", undefined, asKey))).json();
    const row = (e: string) => body.users.find((r: { email: string }) => r.email === e);
    expect(row(open.email).emailVerifiedAt).toBeNull();
    expect(row(done.email).emailVerifiedAt).toBe(done.emailVerifiedAt);
  });
});

/** Rule 777: support resends the code to the account's own address, under the owner's limits, never seeing the code. */
describe("founder console: resend verification code", () => {
  it("mails a fresh code to the owner, logs it, and never returns the code", async () => {
    const u = await newUser("av", { verified: false });
    const res = await resend(u.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resendIn: 60 });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(u.email);
    expect(await hasPendingCode(u.email)).toBe(true);
    expect(await lastLog()).toMatchObject({ actor: "key", email: u.email, what: "resendVerification", sent: true });
  });

  it("refuses a verified owner (409) and sends nothing", async () => {
    const u = await newUser("av");
    const res = await resend(u.email);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_verified" });
    expect(mails).toHaveLength(0);
  });

  it("shares the owner's per-address gap: a second send within 60 s is 429", async () => {
    const u = await newUser("av", { verified: false });
    expect((await resend(u.email)).status).toBe(200);
    const res = await resend(u.email);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(mails).toHaveLength(1);
  });

  it("answers 502 when the mail did not go out, and leaves no code to guess against", async () => {
    mailOk = false;
    const u = await newUser("av", { verified: false });
    const res = await resend(u.email);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "send_failed" });
    expect(await hasPendingCode(u.email)).toBe(false);
    expect(await lastLog()).toMatchObject({ what: "resendVerification", sent: false });
  });

  it("is refused to a signed-in customer and to anyone without the key", async () => {
    const [target, customer] = await Promise.all([newUser("av", { verified: false }), newUser("av")]);
    expect((await resend(target.email, {})).status).toBe(401);
    await signIn(customer.email);
    expect((await resend(target.email, {})).status).toBe(401);
    expect(mails).toHaveLength(0);
  });
});

describe("rules 776-777 in the console UI (src/components/admin since rule 874)", () => {
  it("the console shows the badge and the resend button only while unverified", () => {
    const src = adminConsoleSrc();
    expect(src).toContain("emailVerifiedAt?: string | null");
    expect(src).toMatch(/!u\.emailVerifiedAt && <span[^>]*data-testid="unverified">\{S\.unverified\}/);
    expect(src).toMatch(/!sel\.user\.emailVerifiedAt && <button disabled=\{busy\} onClick=\{\(\) => act\(sel\.user\.email, "resendVerification"\)\}/);
    expect(src).toContain('action === "resendVerification") setMsg(`${email}: ${S.codeSent}`)');
    for (const k of ["unverified", "verifiedOn", "resendCode", "codeSent"]) expect(src.match(new RegExp(`\\b${k}: "`, "g"))?.length, k).toBe(2);
  });
});
