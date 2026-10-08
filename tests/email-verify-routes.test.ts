import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasPendingCode } from "@/lib/verify-email";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
let mailOk = true;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (to: string, subject: string, text: string) => { mails.push({ to, subject, text }); return mailOk; },
}));

import * as send from "@/app/api/auth/verify/send/route";
import * as check from "@/app/api/auth/verify/check/route";
import * as signup from "@/app/api/auth/signup/route";

let ipN = 0;
const freshIp = () => `203.0.113.${(++ipN % 250) + 1}`;
const post = (route: typeof send | typeof check, path: string, body: unknown = {}, ip = freshIp()) =>
  route.POST(json(path, "POST", body, { "x-real-ip": ip }));
const sendCode = (ip?: string) => post(send, "/api/auth/verify/send", {}, ip);
const checkCode = (code: unknown, ip?: string) => post(check, "/api/auth/verify/check", { code }, ip);
const codeIn = (m: Mail) => m.text.match(/\d{6}/)![0];

beforeEach(() => {
  mails = [];
  mailOk = true;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

/** Rules 759-762, 766: the routes that send and check the 6-digit code. */
describe("email verify routes", () => {
  it("send mails a code to an unverified owner", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    const res = await sendCode();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, resendIn: 60 });
    expect(body.devCode).toBeUndefined();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(u.email);
    expect(mails[0].text).toMatch(/\d{6}/);
    expect(await hasPendingCode(u.email)).toBe(true);
  });

  it("second send within 60 s is 429 with Retry-After 60", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    expect((await sendCode()).status).toBe(200);
    const res = await sendCode();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(mails).toHaveLength(1);
  });

  it("sixth send in an hour is 429 with Retry-After 3600", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    for (let i = 0; i < 5; i++) {
      await db.del(`rate:verify:gap:${u.email}`); // the 60 s gap passed
      expect((await sendCode()).status).toBe(200);
    }
    await db.del(`rate:verify:gap:${u.email}`);
    const res = await sendCode();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(mails).toHaveLength(5);
  });

  it("21st send from one IP is 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const u = await newUser("vip", { verified: false });
      await signIn(u.email);
      expect((await sendCode(ip)).status).toBe(200);
    }
    const u = await newUser("vip", { verified: false });
    await signIn(u.email);
    const res = await sendCode(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(mails).toHaveLength(20);
  });

  it("mail_unavailable when mail is off", async () => {
    vi.stubEnv("MAIL_FROM", "");
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    const res = await sendCode();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "mail_unavailable" });
    expect(mails).toHaveLength(0);
    expect(await hasPendingCode(u.email)).toBe(false);
  });

  it("a failed send answers 502 and keeps no code", async () => {
    mailOk = false;
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    const res = await sendCode();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "send_failed" });
    expect(await hasPendingCode(u.email)).toBe(false);
  });

  it("check with the right code verifies", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    await sendCode();
    expect(await currentUser()).toBeNull();
    const res = await checkCode(codeIn(mails[0]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await currentUser())!.email).toBe(u.email);
    expect((await getUser(u.email))!.emailVerifiedAt).toBeTruthy();
    expect(await hasPendingCode(u.email)).toBe(false);
  });

  it("double-submitted correct code answers ok", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    await sendCode();
    const code = codeIn(mails[0]);
    expect((await checkCode(code)).status).toBe(200);
    const again = await checkCode(code);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it("check refuses a wrong code with attemptsLeft", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    await sendCode();
    const right = codeIn(mails[0]);
    const wrong = right === "000000" ? "000001" : "000000";
    const res = await checkCode(wrong);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "wrong_code", attemptsLeft: 4 });
    expect((await getUser(u.email))!.emailVerifiedAt).toBeUndefined();
  });

  it("malformed code does not use an attempt", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    await sendCode();
    const right = codeIn(mails[0]);
    for (const bad of ["12", "", "abcdef", "1234567", undefined, 123456 as unknown]) {
      const r = await checkCode(bad);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("wrong_code");
    }
    const wrong = right === "000000" ? "000001" : "000000";
    expect((await (await checkCode(wrong)).json()).attemptsLeft).toBe(4);
  });

  it("an expired code answers expired and a fifth wrong answer locks", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    expect((await (await checkCode("123456")).json()).error).toBe("expired"); // nothing issued
    await sendCode();
    const right = codeIn(mails[0]);
    const wrong = right === "000000" ? "000001" : "000000";
    let last: { error?: string } = {};
    for (let i = 0; i < 5; i++) last = await (await checkCode(wrong)).json();
    expect(last.error).toBe("locked");
  });

  it("check is 429 after 60 attempts from one IP", async () => {
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    const ip = freshIp();
    for (let i = 0; i < 60; i++) await checkCode("12", ip);
    const res = await checkCode("12", ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("401 without a session", async () => {
    signOut();
    expect((await sendCode()).status).toBe(401);
    expect((await checkCode("123456")).status).toBe(401);
    expect(mails).toHaveLength(0);
  });

  it("409 for a verified owner on send", async () => {
    const u = await newUser("vr");
    await signIn(u.email);
    const res = await sendCode();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_verified" });
    expect(mails).toHaveLength(0);
  });

  it("a member gets 409 on send and ok on check", async () => {
    const owner = await newUser("vr", { verified: false });
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await sendCode()).status).toBe(409);
    const res = await checkCode("123456");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await getUser(owner.email))!.emailVerifiedAt).toBeUndefined();
  });

  it("signup sends the first code", async () => {
    const email = `signup-${Date.now()}@test.example`;
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N" }, { "x-real-ip": freshIp() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verify).toBe(true);
    expect(body.mail).toBe(true);
    expect(body.devCode).toBeUndefined();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(email);
    expect(await hasPendingCode(email)).toBe(true);
  });

  it("signup still succeeds when the mail fails, with mail false", async () => {
    mailOk = false;
    const email = `signup-f-${Date.now()}@test.example`;
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N" }, { "x-real-ip": freshIp() }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, verify: true, mail: false });
    expect(await hasPendingCode(email)).toBe(false);
  });

  it("signup without mail configured answers mail false and sends nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const email = `signup-n-${Date.now()}@test.example`;
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N" }, { "x-real-ip": freshIp() }));
    expect(await res.json()).toMatchObject({ ok: true, verify: true, mail: false });
    expect(mails).toHaveLength(0);
  });

  it("devCode only under APP_ENV=test", async () => {
    vi.stubEnv("APP_ENV", "test");
    const u = await newUser("vr", { verified: false });
    await signIn(u.email);
    const body = await (await sendCode()).json();
    expect(body.devCode).toBe(codeIn(mails[0]));

    const email = `signup-d-${Date.now()}@test.example`;
    const s = await (await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N" }, { "x-real-ip": freshIp() }))).json();
    expect(s.devCode).toBe(codeIn(mails[mails.length - 1]));

    vi.stubEnv("VERCEL_ENV", "production");
    const u2 = await newUser("vr", { verified: false });
    await signIn(u2.email);
    const prod = await (await sendCode()).json();
    expect(prod.ok).toBe(true);
    expect(prod.devCode).toBeUndefined();
  });
});
