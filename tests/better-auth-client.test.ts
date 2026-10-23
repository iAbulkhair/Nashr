import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { jar, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser } from "@/lib/auth";
import { BA_BASE_PATH } from "@/lib/better-auth/server";
import { BA_CLIENT_BASE_PATH, authClient, makeAuthClient, type AuthClient } from "@/lib/better-auth/client";
import {
  AuthQueryError, authQueryError, sessionQueryKey, sessionQueryOptions, userAccountsQueryKey, userAccountsQueryOptions,
  userPasskeysQueryKey, userPasskeysQueryOptions,
} from "@/lib/better-auth/hooks";
import { QUERY_STALE_MS, createQueryClient } from "@/lib/rpc/query-client";
import * as route from "@/app/api/better-auth/[...all]/route";
import { rpcTestClient } from "./helpers/rpc";

/**
 * The browser side of better-auth behind AUTH_ENGINE, step (d) (rules 3418-3420,
 * docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md section 7, docs/system/tests/3400-better-auth-orpc.md).
 * The real client drives the real route handlers in-process through `fetchImpl`, with the switch off and on.
 */
type Mail = { to: string; template?: string; context?: { link?: string } };
const sent: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => { sent.push(a[0] as Mail); return true; },
}));

const SECRET = randomBytes(24).toString("hex");
const ORIGIN = "https://thakeen.com";
const PASSWORD = "abc12345";
const on = () => { vi.stubEnv("AUTH_ENGINE", "better-auth"); vi.stubEnv("BETTER_AUTH_SECRET", SECRET); };
const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>"); };
beforeEach(() => { sent.length = 0; });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

let ipN = 0;
/** Never repeats within a run, and never meets the IPs other test files use. */
const freshIp = () => { ipN++; return `100.64.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };

/** What the browser would send, handed to the route modules instead of the network. */
const seen: { url: string; method: string; credentials?: string }[] = [];
const inProcess: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://nashr.test");
  const method = (init?.method ?? "GET").toUpperCase();
  seen.push({ url: url.href, method, credentials: init?.credentials });
  const headers = new Headers(init?.headers);
  headers.set("origin", ORIGIN);
  headers.set("x-forwarded-for", freshIp());
  const req = new Request(url, { method, headers, ...(method === "GET" ? {} : { body: init?.body as BodyInit }) });
  if (url.pathname.startsWith("/api/better-auth/")) return method === "GET" ? route.GET(req) : route.POST(req);
  return new Response("{}", { status: 599 });
};
const client = (): AuthClient => makeAuthClient({ baseURL: "https://nashr.test", fetchImpl: inProcess });
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);

describe("rule 3418: one better-auth client, same origin, only the wrapper", () => {
  it("its base path is the server's, written out so the client never imports the server config", () => {
    expect(BA_CLIENT_BASE_PATH).toBe(BA_BASE_PATH);
    const src = readFileSync("src/lib/better-auth/client.ts", "utf8");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["better-auth/client/plugins", "better-auth/react"]);
    expect(src).not.toMatch(/process\.env/);
  });

  it("off: every client method gets the wrapper's 404, and nothing is written", async () => {
    const u = await newUser("cl");
    signOut();
    const c = client();
    for (const res of [
      await c.getSession(),
      await c.listAccounts(),
      await c.signIn.email({ email: u.email, password: PASSWORD }),
      await c.signIn.magicLink({ email: u.email }),
      await c.signOut(),
    ]) {
      expect(res.data).toBeNull();
      expect(res.error).toMatchObject({ status: 404, error: "not_found" });
    }
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("on: signed out, the session is null; a password sign-in sets the one cookie; the session and accounts carry no secret", async () => {
    on();
    const u = await newUser("cl");
    signOut();
    const c = client();
    expect(await c.getSession()).toMatchObject({ data: null, error: null });

    const res = await c.signIn.email({ email: u.email, password: PASSWORD });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ ok: true, redirect: false, user: { email: u.email } });
    expect(jar().get("thakeen_session")).toMatch(/^[0-9a-f]{64}$/);
    expect((await currentUser())!.email).toBe(u.email);

    const s = await c.getSession();
    expect(s.error).toBeNull();
    expect(s.data).toMatchObject({ user: { email: u.email, emailVerified: true }, session: { userId: s.data!.user.id } });
    const a = await c.listAccounts();
    expect(a.error).toBeNull();
    expect(a.data).toEqual([expect.objectContaining({ providerId: "credential" })]);
    for (const v of [res.data, s.data, a.data]) {
      expect(keysOf(v)).not.toEqual(expect.arrayContaining(["token"]));
      for (const k of ["password", "passHash", "ipAddress", "userAgent", "accessToken", "refreshToken", "idToken"]) expect(keysOf(v)).not.toContain(k);
    }
    expect(JSON.stringify([res.data, s.data, a.data])).not.toContain(jar().get("thakeen_session")!);

    expect(await c.signOut()).toMatchObject({ data: { success: true }, error: null });
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(await currentUser()).toBeNull();
    expect(await c.getSession()).toMatchObject({ data: null, error: null });
  });

  it("on: a wrong password is the legacy `invalid`; a member signs in through the same client", async () => {
    on();
    const owner = await newUser("cl");
    const m = await newMember(owner, "member", "cm");
    signOut();
    const c = client();
    expect((await c.signIn.email({ email: owner.email, password: "wrong-pass-1" })).error).toMatchObject({ status: 401, error: "invalid" });
    expect(jar().get("thakeen_session")).toBeUndefined();
    const res = await c.signIn.email({ email: m.email, password: PASSWORD });
    expect(res.error).toBeNull();
    expect((await currentUser())!.actor).toMatchObject({ kind: "member" });
  });

  it("on: the magic-link client posts the address only and gets the one answer; the link is mailed", async () => {
    on();
    mailOn();
    const u = await newUser("cl");
    signOut();
    const c = client();
    const res = await c.signIn.magicLink({ email: u.email });
    expect(res).toMatchObject({ data: { ok: true, status: true, mail: true }, error: null });
    const unknown = await c.signIn.magicLink({ email: "nobody-cl@test.example" });
    expect(unknown.data).toEqual(res.data);
    expect(sent.map((m) => [m.to, m.template])).toEqual([[u.email, "magicLink"]]);
    expect(sent[0].context!.link).toContain("/app/magic#t=");
  });

  it("on: a method for a path off the allow-list is the wrapper's 404, never a better-auth endpoint", async () => {
    on();
    const u = await newUser("cl");
    const c = client();
    for (const p of ["/list-sessions", "/revoke-sessions", "/update-user", "/delete-user", "/sign-up/email", "/magic-link/verify"]) {
      const res = (await c.$fetch(p, { method: p === "/list-sessions" || p === "/magic-link/verify" ? "GET" : "POST", body: p.startsWith("/sign-up") ? { email: "x@nashr.test", password: PASSWORD, name: "x" } : undefined })) as { data: unknown; error: unknown };
      expect(res.error).toMatchObject({ status: 404, error: "not_found" });
    }
    await signIn(u.email);
    expect((await currentUser())!.email).toBe(u.email);
  });

  it("sends `credentials: same-origin` and only to its own base", async () => {
    on();
    seen.length = 0;
    await client().getSession();
    expect(seen).toEqual([{ url: "https://nashr.test/api/better-auth/get-session", method: "GET", credentials: "same-origin" }]);
  });

  it("authClient() is browser-only, and in the browser takes the page's own origin once", async () => {
    expect(() => authClient()).toThrow(/browser only/);
    vi.stubEnv("BETTER_AUTH_URL", "https://evil.example");
    vi.stubEnv("NEXT_PUBLIC_BETTER_AUTH_URL", "https://evil.example");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => { calls.push(String(input instanceof Request ? input.url : input)); return Response.json(null); });
    vi.stubGlobal("window", { location: { origin: ORIGIN, href: `${ORIGIN}/ar/app` } });
    const first = authClient();
    expect(authClient()).toBe(first);
    await first.getSession();
    expect(calls).toEqual([`${ORIGIN}/api/better-auth/get-session`]);
  });
});

describe("rule 3419: query hooks over the client, keys exported, legacy codes as errors", () => {
  it("keys are Supastarter's", () => {
    expect(sessionQueryKey).toEqual(["user", "session"]);
    expect(userAccountsQueryKey).toEqual(["user", "accounts"]);
    expect(userPasskeysQueryKey).toEqual(["user", "passkeys"]);
  });

  it("session options: never stale, never refetched on focus, never retried; the default builds nothing on the server", async () => {
    const o = sessionQueryOptions();
    expect(o).toMatchObject({ queryKey: ["user", "session"], staleTime: Infinity, refetchOnWindowFocus: false, retry: false });
    await expect(createQueryClient().fetchQuery(o)).rejects.toThrow(/browser only/);
  });

  it("off: the session query fails with the wrapper's code; on: null, then the person, then null again", async () => {
    const u = await newUser("cl");
    signOut();
    const c = client();
    const off = createQueryClient().fetchQuery(sessionQueryOptions(() => c));
    await expect(off).rejects.toBeInstanceOf(AuthQueryError);
    await expect(off).rejects.toMatchObject({ code: "not_found", status: 404 });

    on();
    const qc = createQueryClient();
    expect(await qc.fetchQuery(sessionQueryOptions(() => c))).toBeNull();
    await c.signIn.email({ email: u.email, password: PASSWORD });
    await qc.invalidateQueries({ queryKey: sessionQueryKey });
    expect(await qc.fetchQuery(sessionQueryOptions(() => c))).toMatchObject({ user: { email: u.email } });
    expect(await qc.fetchQuery(userAccountsQueryOptions(() => c))).toEqual([expect.objectContaining({ providerId: "credential" })]);
    await c.signOut();
    await qc.invalidateQueries({ queryKey: sessionQueryKey });
    expect(await qc.fetchQuery(sessionQueryOptions(() => c))).toBeNull();
  });

  it("accounts while signed out on the new engine: better-auth's 401 comes back as a legacy code", async () => {
    on();
    signOut();
    await expect(createQueryClient().fetchQuery(userAccountsQueryOptions(client))).rejects.toMatchObject({ status: 401 });
  });

  it("passkeys go through oRPC (rule 3424): off the legacy 404, on the card's own list, signed out a 401", async () => {
    const u = await newUser("cl");
    await signIn(u.email);
    const viaRpc = rpcTestClient;
    const off = createQueryClient().fetchQuery(userPasskeysQueryOptions(viaRpc));
    await expect(off).rejects.toBeInstanceOf(AuthQueryError);
    await expect(off).rejects.toMatchObject({ code: "not_found", status: 404 });

    on();
    const list = await createQueryClient().fetchQuery(userPasskeysQueryOptions(viaRpc));
    expect(list).toEqual({ items: [], max: expect.any(Number), enabled: expect.any(Boolean), proof: "password" });
    signOut();
    await expect(createQueryClient().fetchQuery(userPasskeysQueryOptions(viaRpc))).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("the passkeys default builds nothing on the server: the call throws before any request", async () => {
    await expect(createQueryClient().fetchQuery(userPasskeysQueryOptions())).rejects.toMatchObject({ code: "failed" });
  });

  it("authQueryError keeps a known code and status and calls anything else `failed`", () => {
    expect(authQueryError({ error: "slow_down", status: 429 })).toMatchObject({ code: "slow_down", status: 429 });
    expect(authQueryError({ message: "boom" }, 500)).toMatchObject({ code: "failed", status: 500 });
    expect(authQueryError(null)).toMatchObject({ code: "failed", status: 0 });
  });
});

describe("rule 3420: one query cache per mount, retries off, mounted only where used", () => {
  it("defaults: a minute fresh, no retries, no refetch on focus", () => {
    const d = createQueryClient().getDefaultOptions();
    expect(QUERY_STALE_MS).toBe(60_000);
    expect(d.queries).toMatchObject({ staleTime: 60_000, retry: false, refetchOnWindowFocus: false });
    expect(d.mutations).toMatchObject({ retry: false });
    expect(createQueryClient()).not.toBe(createQueryClient());
  });

  it("the provider makes its cache per mount, never at module level", () => {
    const src = readFileSync("src/components/app/QueryProvider.tsx", "utf8");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain("useState(createQueryClient)");
    expect(src).not.toMatch(/new QueryClient\(/);
    expect(src.replace("useState(createQueryClient)", "")).not.toMatch(/createQueryClient\(/);
  });

  it("no page or layout mounts the provider or the hooks except the screens of rule 3424", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
    walk("src/app");
    walk("src/components");
    const users = files.filter((f) => /QueryProvider|better-auth\/hooks|rpc\/client/.test(readFileSync(f, "utf8")) && !f.endsWith("QueryProvider.tsx"));
    expect(users.sort()).toEqual(ALLOWED_USERS);
  });
});

/**
 * The screens that use the hooks, the provider or the oRPC client: the security screen's device list (rule 3424), which
 * loads the client only while AUTH_ENGINE is on. No page mounts the provider yet.
 */
const ALLOWED_USERS: string[] = ["src/components/app/settings/DeviceList.tsx"];
