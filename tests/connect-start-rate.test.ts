import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { jar, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { handleOf } from "@/lib/ws-handle";
import { globalKey, wsKey } from "@/lib/keys";
import { CONNECT_STARTS_PER_HOUR } from "@/lib/rate";
import { OAUTH_COOKIE } from "@/lib/connectors/store";
import { bucketFor, composioUserId, setComposioClientForTests, type ComposioClient } from "@/lib/connectors/composio";
import * as start from "@/app/api/connect/[provider]/start/route";

/**
 * Rule 2242 (docs/system/tests/2240-key-check-rate.md): every connect start writes an OAuth state and, through Composio,
 * opens a pending connection on the one Composio account every tenant shares, so starts are limited to twenty an hour
 * per workspace, every provider together. A refusal sends the browser back to the Integrations page with
 * `error=slow_down` and writes no state.
 */

const go = (provider = "x", q = "lang=en") => start.GET(new Request(`https://app.test/api/connect/${provider}/start?${q}`), params({ provider }));
const bucket = (scope: string) => globalKey.rate(wsKey.connectStartBucket(scope as Parameters<typeof wsKey.connectStartBucket>[0]));

afterEach(() => {
  signOut();
  vi.unstubAllEnvs();
});

describe("connect starts are limited per workspace (rule 2242)", () => {
  it("twenty starts an hour go to the provider; the next goes back to the page with slow_down and no new state", async () => {
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xsecret");
    const u = await newUser("startrate");
    await signIn(u.email);
    for (let i = 0; i < CONNECT_STARTS_PER_HOUR; i++) {
      const r = await go();
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location")!).searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    }
    const refused = await go("x", "lang=ar");
    expect(refused.status).toBe(307);
    const back = new URL(refused.headers.get("location")!);
    expect(back.pathname).toBe(`/ar/app/w/${handleOf(u)}/b/default/settings/connections`);
    expect(back.searchParams.get("error")).toBe("slow_down");
    expect(back.searchParams.has("state")).toBe(false);
    expect(refused.headers.get("Retry-After")).toBe("3600");
  });

  it("every provider counts together, the bucket is the caller's own workspace, and another workspace is not touched", async () => {
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xsecret");
    vi.stubEnv("SHOPIFY_CLIENT_ID", "sid");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "ssecret");
    const a = await newUser("startrate-a");
    const b = await newUser("startrate-b");
    await signIn(a.email);
    await db.set(bucket(sc(a)), CONNECT_STARTS_PER_HOUR - 1, 3600);
    expect(new URL((await go("shopify", "shop=a.myshopify.com")).headers.get("location")!).host).toBe("a.myshopify.com");
    expect(new URL((await go("x")).headers.get("location")!).searchParams.get("error")).toBe("slow_down");
    signOut();
    await signIn(b.email);
    expect(new URL((await go("x")).headers.get("location")!).host).not.toBe("app.test");
    expect(Number(await db.get(bucket(sc(b))))).toBe(1);
  });

  it("a member without the connectors role or an unknown provider is refused before a start is counted", async () => {
    const u = await newUser("startrate-free");
    const m = await newMember(u, "member");
    await signIn(m.email);
    expect((await go()).status).toBe(403);
    signOut();
    await signIn(u.email);
    expect((await go("nope")).status).toBe(404);
    expect(await db.get(bucket(sc(u)))).toBeNull();
  });

  it("through Composio: a start counts, links once and keeps the account id server-side; a full bucket never reaches Composio", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_PROVIDERS", "x");
    vi.stubEnv("COMPOSIO_AUTH_TWITTER", "ac_twitter");
    const links: { userId: string; auth: string; callbackUrl: string }[] = [];
    const fake = {
      connectedAccounts: {
        link: async (userId: string, auth: string, o: { callbackUrl: string }) => { links.push({ userId, auth, callbackUrl: o.callbackUrl }); return { id: `ca_${links.length}`, redirectUrl: "https://connect.composio.dev/link/lk_1" }; },
        waitForConnection: async (id: string) => ({ id, status: "ACTIVE" }),
        list: async () => ({ items: [] }),
        revoke: async () => {},
        delete: async () => {},
      },
      tools: { execute: async () => ({ successful: false, error: "not mocked" }) },
      files: { upload: async () => ({}) },
    } as unknown as ComposioClient;
    setComposioClientForTests(fake);
    try {
      const u = await newUser("startrate-composio");
      await signIn(u.email);

      // Happy path: the browser goes to Composio, the bucket holds one start, the state keeps the pending account.
      const ok = await go("x");
      expect(ok.headers.get("location")).toBe("https://connect.composio.dev/link/lk_1");
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ userId: composioUserId(sc(u)), auth: "ac_twitter" });
      const state = jar().get(OAUTH_COOKIE)!;
      expect(links[0].callbackUrl).toContain(`/api/connect/x/callback?state=${state}`);
      expect(await db.get(`oauthstate:${state}`)).toMatchObject({ email: sc(u), provider: "x", via: "composio", toolkit: "twitter", accountId: "ca_1" });
      expect(Number(await db.get(bucket(sc(u))))).toBe(1);

      // Composio's own per-workspace limit is still reported by its code, after the start counted.
      await db.set(globalKey.rate(bucketFor(sc(u))), 10_000, 3600);
      const busy = new URL((await go("x")).headers.get("location")!);
      expect(busy.searchParams.get("error")).toBe("composio_rate_limited");
      expect(links).toHaveLength(1);
      expect(Number(await db.get(bucket(sc(u))))).toBe(2);
      await db.del(globalKey.rate(bucketFor(sc(u))));

      // A full start bucket goes back to the page before Composio is asked, and writes no new state.
      await db.set(bucket(sc(u)), CONNECT_STARTS_PER_HOUR, 3600);
      jar().delete(OAUTH_COOKIE);
      const refused = new URL((await go("x", "lang=ar")).headers.get("location")!);
      expect(refused.pathname).toBe(`/ar/app/w/${handleOf(u)}/b/default/settings/connections`);
      expect(refused.searchParams.get("error")).toBe("slow_down");
      expect(links).toHaveLength(1);
      expect(jar().get(OAUTH_COOKIE)).toBeUndefined();
    } finally {
      setComposioClientForTests(null);
    }
  });

  it("the start counts before Composio is asked or a state is written", () => {
    const src = readFileSync("src/app/api/connect/[provider]/start/route.ts", "utf8");
    const take = src.indexOf("allow(wsKey.connectStartBucket(sc(u)), CONNECT_STARTS_PER_HOUR, WINDOW.hour)");
    expect(take).toBeGreaterThan(src.indexOf('forbid(u, p?.secretary ? "calendar.link" : "connectors")'));
    expect(take).toBeGreaterThan(src.indexOf("if (!isAvailable(p))"));
    expect(take).toBeLessThan(src.indexOf("await composioConnect("));
    expect(take).toBeLessThan(src.indexOf("await saveState("));
    expect(CONNECT_STARTS_PER_HOUR).toBe(20);
  });
});
