import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, verifyPassword } from "@/lib/auth";
import { allUsers } from "@/lib/schedule";
import { userFromBearer } from "@/lib/mcp";
import { db } from "@/lib/db";

const sent: { to: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (to: string, _s: string, text: string) => { sent.push({ to, text }); return true; } }));

import * as login from "@/app/api/auth/login/route";
import * as forgot from "@/app/api/auth/forgot/route";
import * as reset from "@/app/api/auth/reset/route";

// Each test gets its own client IP so one test's throttle window never leaks into the next.
let ipN = 0;
const ip = () => ({ "x-real-ip": `203.0.113.${++ipN}` });
const tokenFrom = (text: string) => text.match(/token=([a-f0-9]{64})/)![1];

beforeEach(() => { sent.length = 0; signOut(); vi.stubEnv("RESEND_API_KEY", "test-key"); });

describe("login throttle (rule 8)", () => {
  it("locks an account after 8 attempts in the window, even with the right password, and opens again after it", async () => {
    const u = await newUser("login");
    for (let i = 0; i < 8; i++) expect((await login.POST(json("/api/auth/login", "POST", { email: u.email, password: "wrong-pass1" }, ip()))).status).toBe(401);
    expect((await login.POST(json("/api/auth/login", "POST", { email: u.email, password: "abc12345" }, ip()))).status).toBe(429);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 901e3);
    const res = await login.POST(json("/api/auth/login", "POST", { email: u.email, password: "abc12345" }, ip()));
    vi.useRealTimers();
    expect(res.status).toBe(200);
  });
  it("throttles one IP across many accounts", async () => {
    const h = ip();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await login.POST(json("/api/auth/login", "POST", { email: `nobody${i}@test.example`, password: "x" }, h))).status);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe("password reset (rule 9)", () => {
  it("answers the same for a known and an unknown email, and only the known one gets a link", async () => {
    const u = await newUser("reset");
    const known = await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email, lang: "ar" }, ip()));
    const unknown = await forgot.POST(json("/api/auth/forgot", "POST", { email: "ghost@test.example", lang: "ar" }, ip()));
    expect(await known.json()).toEqual(await unknown.json());
    expect(known.status).toBe(unknown.status);
    expect(sent.map((m) => m.to)).toEqual([u.email]);
  });
  it("stores only a hash of the token, accepts it once, then never again", async () => {
    const u = await newUser("reset");
    await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email }, ip()));
    const token = tokenFrom(sent[0].text);
    expect(await db.get(`pwreset:${token}`)).toBeNull(); // the raw token is not a key
    expect((await reset.POST(json("/api/auth/reset", "POST", { token, password: "weak" }, ip()))).status).toBe(400);
    expect((await reset.POST(json("/api/auth/reset", "POST", { token, password: "newpass123" }, ip()))).status).toBe(200);
    expect(await verifyPassword((await getUser(u.email))!, "newpass123")).toBe(true);
    expect((await currentUser())!.email).toBe(u.email); // signed in
    expect((await reset.POST(json("/api/auth/reset", "POST", { token, password: "another123" }, ip()))).status).toBe(400);
    expect(await verifyPassword((await getUser(u.email))!, "newpass123")).toBe(true);
  });
  it("refuses the token after one hour", async () => {
    const u = await newUser("reset");
    await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email }, ip()));
    const token = tokenFrom(sent[0].text);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3601e3);
    const res = await reset.POST(json("/api/auth/reset", "POST", { token, password: "newpass123" }, ip()));
    vi.useRealTimers();
    expect(res.status).toBe(400);
    expect(await verifyPassword((await getUser(u.email))!, "abc12345")).toBe(true);
  });
  it("sends at most three links per account per window and creates no token when mail is not configured", async () => {
    const u = await newUser("reset");
    for (let i = 0; i < 5; i++) await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email }, ip()));
    expect(sent).toHaveLength(3);
    sent.length = 0;
    vi.stubEnv("RESEND_API_KEY", "");
    const other = await newUser("reset");
    const body = (await (await forgot.POST(json("/api/auth/forgot", "POST", { email: other.email }, ip()))).json()) as { mail: boolean };
    expect(body.mail).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("suspended accounts (rule 11)", () => {
  it("are blocked in the app, in MCP, in cron and at login", async () => {
    const u = await newUser("susp");
    await signIn(u.email);
    await db.set("mcptoken:nashr_testtoken123", u.email);
    const bearer = new Request("https://nashr.test/api/mcp", { headers: { authorization: "Bearer nashr_testtoken123" } });
    expect((await currentUser())!.email).toBe(u.email);
    expect((await userFromBearer(bearer))!.email).toBe(u.email);
    expect((await allUsers()).some((x) => x.email === u.email)).toBe(true);

    await saveUser({ ...(await getUser(u.email))!, suspended: true });
    expect(await currentUser()).toBeNull(); // the session cookie is still there
    expect(await userFromBearer(bearer)).toBeNull();
    expect((await allUsers()).some((x) => x.email === u.email)).toBe(false);
    expect((await login.POST(json("/api/auth/login", "POST", { email: u.email, password: "abc12345" }, ip()))).status).toBe(403);
  });
});
