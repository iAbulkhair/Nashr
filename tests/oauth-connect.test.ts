import { createHmac } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jar, newUser, signIn, signOut } from "./helpers/session";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState } from "@/lib/connectors/store";
import { getFreshConnection } from "@/lib/connectors/fresh";
import { publishTask } from "@/lib/connectors/publish";
import type { Task } from "@/lib/brand";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";

/**
 * Rules 67-70, the connector OAuth flow, pinned before any platform app credentials go into production:
 * the callback completes only for the browser and the account that started it (#37), a state is bound to its
 * provider (#38), a Shopify shop is a real store host (#39) and the Shopify callback is signed (#113), and an
 * expiring token is refreshed before use or the connection is marked for reconnecting (#34).
 */
const ENV = { X_CLIENT_ID: "xid", X_CLIENT_SECRET: "xsecret", SHOPIFY_CLIENT_ID: "sid", SHOPIFY_CLIENT_SECRET: "ssecret", LINKEDIN_CLIENT_ID: "lid", LINKEDIN_CLIENT_SECRET: "lsecret" };
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ENV)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const realFetch = globalThis.fetch;
let tokenCalls: string[] = [];
function fakeProviders(opts: { refreshStatus?: number } = {}) {
  tokenCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    if (url.includes("oauth2/token") || url.includes("access_token")) {
      tokenCalls.push(body);
      if (body.includes("grant_type=refresh_token")) {
        if (opts.refreshStatus) return new Response("invalid_grant", { status: opts.refreshStatus });
        return Response.json({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 7200 });
      }
      return Response.json({ access_token: "first-access", refresh_token: "first-refresh", expires_in: 7200 });
    }
    if (url.endsWith("/2/users/me")) return Response.json({ data: { username: "shop", name: "Shop" } });
    if (url.endsWith("/2/tweets")) {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === "Bearer new-access" ? Response.json({ data: { id: "1" } }) : new Response("unauthorized", { status: 401 });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const errorOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("error");

describe("connector OAuth callback is bound to the browser and account that started it (rule 67, #37)", () => {
  it("refuses a signed-out browser, and a different account, without exchanging the code", async () => {
    fakeProviders();
    const victim = await newUser("oauthv");
    await saveState("s-victim-1", { email: victim.email, provider: "x", lang: "en", shop: "", verifier: "v" });
    signOut();
    jar().set(OAUTH_COOKIE, "s-victim-1");
    expect(errorOf(await callback.GET(new Request("https://app.test/api/connect/x/callback?state=s-victim-1&code=c"), ctx("x")))).toBe("session_mismatch");

    const attacker = await newUser("oautha");
    await saveState("s-victim-2", { email: victim.email, provider: "x", lang: "en", shop: "", verifier: "v" });
    await signIn(attacker.email);
    jar().set(OAUTH_COOKIE, "s-victim-2");
    expect(errorOf(await callback.GET(new Request("https://app.test/api/connect/x/callback?state=s-victim-2&code=c"), ctx("x")))).toBe("session_mismatch");

    expect(tokenCalls).toEqual([]);
    expect(await getConnection(victim.email, "x")).toBeNull();
  });

  it("refuses the right account in a browser that did not start the flow", async () => {
    fakeProviders();
    const u = await newUser("oauthc");
    await saveState("s-nocookie", { email: u.email, provider: "x", lang: "en", shop: "", verifier: "v" });
    await signIn(u.email);
    expect(errorOf(await callback.GET(new Request("https://app.test/api/connect/x/callback?state=s-nocookie&code=c"), ctx("x")))).toBe("session_mismatch");
    expect(tokenCalls).toEqual([]);
  });

  it("connects when the account that started the flow finishes it in the same browser", async () => {
    fakeProviders();
    const u = await newUser("oauthok");
    await signIn(u.email);
    const res = await start.GET(new Request("https://app.test/api/connect/x/start?lang=en"), ctx("x"));
    expect(res.status).toBe(307);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    expect(jar().get(OAUTH_COOKIE)).toBe(state);
    const done = await callback.GET(new Request(`https://app.test/api/connect/x/callback?state=${state}&code=c`), ctx("x"));
    expect(new URL(done.headers.get("location")!).searchParams.get("connected")).toBe("x");
    expect((await getConnection(u.email, "x"))?.data.access_token).toBe("first-access");
    expect(jar().has(OAUTH_COOKIE)).toBe(false);
  });
});

describe("a state completes only the provider it was issued for (rule 68, #38)", () => {
  it("refuses an X state on the LinkedIn callback", async () => {
    fakeProviders();
    const u = await newUser("oauthp");
    await saveState("s-cross", { email: u.email, provider: "x", lang: "en", shop: "", verifier: "v" });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "s-cross");
    expect(errorOf(await callback.GET(new Request("https://app.test/api/connect/linkedin/callback?state=s-cross&code=c"), ctx("linkedin")))).toBe("invalid_state");
    expect(tokenCalls).toEqual([]);
  });
});

describe("Shopify: a real store host, and a signed callback (rule 69, #39 #113)", () => {
  const sign = (q: URLSearchParams) => {
    const msg = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
    q.set("hmac", createHmac("sha256", ENV.SHOPIFY_CLIENT_SECRET).update(msg).digest("hex"));
    return q;
  };

  it("refuses a shop that is not a myshopify.com host before redirecting anywhere", async () => {
    const u = await newUser("shopbad");
    await signIn(u.email);
    for (const shop of ["evil.com", "evil.com/x", "a.b.myshopify.com.evil.com"]) {
      const res = await start.GET(new Request(`https://app.test/api/connect/shopify/start?shop=${encodeURIComponent(shop)}`), ctx("shopify"));
      expect(res.status).toBe(400);
    }
  });

  it("refuses a missing or wrong signature and a shop that differs from the state, then accepts a signed callback", async () => {
    fakeProviders();
    const u = await newUser("shophmac");
    await signIn(u.email);
    const run = async (state: string, q: URLSearchParams) => {
      await saveState(state, { email: u.email, provider: "shopify", lang: "en", shop: "store.myshopify.com", verifier: "" });
      jar().set(OAUTH_COOKIE, state);
      return callback.GET(new Request(`https://app.test/api/connect/shopify/callback?${q}`), ctx("shopify"));
    };
    const base = (state: string, shop = "store.myshopify.com") => new URLSearchParams({ code: "c", shop, state, timestamp: "1" });

    expect(errorOf(await run("h1", base("h1")))).toBe("bad_hmac");
    const wrong = base("h2"); wrong.set("hmac", "00".repeat(32));
    expect(errorOf(await run("h2", wrong))).toBe("bad_hmac");
    expect(errorOf(await run("h3", sign(base("h3", "other.myshopify.com"))))).toBe("bad_shop");
    expect(tokenCalls).toEqual([]);

    const ok = await run("h4", sign(base("h4")));
    expect(new URL(ok.headers.get("location")!).searchParams.get("connected")).toBe("shopify");
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("an expiring token is refreshed before use, or the owner is asked to reconnect (rule 70, #34)", () => {
  const task: Task = { id: "t1", type: "social", channel: "x", title: "t", body: "hello", status: "approved", createdAt: new Date().toISOString(), lang: "en" };
  const expired = () => ({ provider: "x", data: { access_token: "old-access", refresh_token: "old-refresh" }, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });

  it("refreshes an expired X token, posts with the new one and stores the rotated refresh token", async () => {
    fakeProviders();
    const u = await newUser("refresh");
    await saveConnection(u.email, expired());
    const r = await publishTask(u.email, task, "x");
    expect(r.id).toBe("1");
    expect(tokenCalls.some((b) => b.includes("refresh_token=old-refresh"))).toBe(true);
    const c = await getConnection(u.email, "x");
    expect(c?.data.refresh_token).toBe("rotated-refresh");
    expect(new Date(c!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the connection for reconnecting when the refresh is refused, and says so instead of the raw error", async () => {
    fakeProviders({ refreshStatus: 400 });
    const u = await newUser("refresh2");
    await saveConnection(u.email, expired());
    await expect(publishTask(u.email, task, "x")).rejects.toThrow("reconnect_required");
    expect((await getConnection(u.email, "x"))?.needsReconnect).toBeTruthy();
    await expect(getFreshConnection(u.email, "x")).rejects.toThrow("reconnect_required");
  });

  it("marks the connection when the platform refuses a token that was not due", async () => {
    fakeProviders();
    const u = await newUser("refresh3");
    await saveConnection(u.email, { ...expired(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await expect(publishTask(u.email, task, "x")).rejects.toThrow("reconnect_required");
    expect((await getConnection(u.email, "x"))?.needsReconnect).toBeTruthy();
  });
});
