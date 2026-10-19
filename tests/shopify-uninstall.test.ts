import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { applyShopRedactions, backfillUninstallHooks, COMPLIANCE_TOPICS, HOOKS_PER_RUN, isShopHookTopic, UNINSTALL_TOPIC } from "@/lib/connectors/shopify-compliance";
import { SHOPIFY_HOOK_PATH, subscribeUninstall, UNINSTALL_HOOK_META, UNINSTALL_TRIED_META } from "@/lib/connectors/shopify";
import * as route from "@/app/api/shopify/compliance/route";

/**
 * Rule 2203 (docs/system/tests/2160-integrations-panel-drift.md): Shopify tells us when a store uninstalls the app.
 * The connect callback subscribes `app/uninstalled` to the compliance URL, and the delivery puts the store on the
 * same pending list `shop/redact` uses, so the next stores run drops the dead connection instead of 48 hours later.
 * Rule 2204: a store already subscribed is not subscribed twice, the connection carries a mark once it is, and the
 * stores cron subscribes the Shopify connections without the mark.
 */

const SECRET = "SENTINEL-shopify-app-secret";
let ip = 0;
const delivery = (topic: string, payload: Record<string, unknown>) => {
  const body = JSON.stringify(payload);
  return route.POST(new Request("https://thakeen.test/api/shopify/compliance", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.22.${++ip % 250}.${ip % 250}`, "x-shopify-topic": topic, "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body, "utf8").digest("base64") },
  }));
};
const shopConn = (shop: string, connectedAt: string): Connection => ({ provider: "shopify", data: { access_token: "shpat_SENTINEL" }, meta: { shop }, connectedAt });

beforeEach(async () => {
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  await Promise.all([db.del(globalKey.shopifyCompliance()), db.del(globalKey.shopifyRedact())]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("app/uninstalled joins the pending list at once (rule 2203)", () => {
  it("the URL takes the topic, which stays out of the compliance list Shopify's review checks", () => {
    expect(UNINSTALL_TOPIC).toBe("app/uninstalled");
    expect(COMPLIANCE_TOPICS).not.toContain(UNINSTALL_TOPIC);
    expect(isShopHookTopic("app/uninstalled")).toBe(true);
    expect(isShopHookTopic("shop/redact")).toBe(true);
    expect(isShopHookTopic("orders/create")).toBe(false);
    expect(isShopHookTopic(null)).toBe(false);
  });

  it("a signed delivery records the store from `myshopify_domain`, only the store and the time", async () => {
    const res = await delivery("app/uninstalled", { id: 1, name: "SENTINEL Store", email: "SENTINEL-owner@example.com", domain: "shop.example.com", myshopify_domain: "A.myshopify.com" });
    expect(res.status).toBe(200);
    const pending = await db.hgetall<string>(globalKey.shopifyRedact());
    expect(Object.keys(pending)).toEqual(["a.myshopify.com"]);
    const log = await db.lrange(globalKey.shopifyCompliance(), 0, -1);
    expect(log.map((r) => JSON.parse(r) as { topic: string; shop: string })).toEqual([expect.objectContaining({ topic: "app/uninstalled", shop: "a.myshopify.com" })]);
    expect(log.join()).not.toMatch(/SENTINEL|shop\.example\.com/);
  });

  it("400 for a body without a real store, and the custom domain is never taken for the store", async () => {
    expect((await delivery("app/uninstalled", { domain: "a.myshopify.com" })).status).toBe(400);
    expect((await delivery("app/uninstalled", { myshopify_domain: "evil.example.com" })).status).toBe(400);
    // The uninstall body carries `myshopify_domain`; a compliance-style `shop_domain` alone is not read for it.
    expect((await delivery("app/uninstalled", { shop_domain: "a.myshopify.com" })).status).toBe(400);
    expect(await db.hgetall(globalKey.shopifyRedact())).toEqual({});
  });

  it("the next stores run drops the connection; a store connected again after the uninstall is kept", async () => {
    const before = new Date(Date.now() - 86400e3).toISOString();
    const [gone, again] = await Promise.all(["uninstall-a", "uninstall-b"].map((t) => newUser(t).then((u) => u.email)));
    await Promise.all([
      saveConnection(gone, shopConn("a.myshopify.com", before)),
      saveConnection(again, shopConn("a.myshopify.com", new Date(Date.now() + 60_000).toISOString())),
    ]);
    expect((await delivery("app/uninstalled", { myshopify_domain: "a.myshopify.com" })).status).toBe(200);
    expect(await applyShopRedactions([gone, again])).toBe(1);
    expect(await getConnection(gone, "shopify")).toBeNull();
    expect(await getConnection(again, "shopify")).not.toBeNull();
    expect(await db.hgetall(globalKey.shopifyRedact())).toEqual({});
  });
});

type Call = { url: string; query: string; variables: Record<string, unknown>; token: string };
/** A fake store: `existing` subscriptions to our URL, `create` the mutation's userErrors, `fail` stores that answer 500. */
function fakeShopify(o: { existing?: string[]; userErrors?: { message: string }[]; fail?: string[] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const b = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, query: b.query, variables: b.variables, token: init.headers["X-Shopify-Access-Token"] });
    if ((o.fail ?? []).some((h) => url.startsWith(`https://${h}/`))) return new Response("{}", { status: 500 });
    if (b.query.includes("webhookSubscriptions(")) return Response.json({ data: { webhookSubscriptions: { nodes: (o.existing ?? []).filter((h) => url.startsWith(`https://${h}/`)).map((h) => ({ id: `gid://shopify/WebhookSubscription/${h}` })) } } });
    return Response.json({ data: { webhookSubscriptionCreate: { userErrors: o.userErrors ?? [] } } });
  }));
  return calls;
}

describe("subscribeUninstall: one subscription per store, best effort (rules 2203-2204)", () => {
  const conn = shopConn("a.myshopify.com", "2026-10-18T00:00:00Z");
  const URI = "https://thakeen.test/api/shopify/compliance";

  it("looks for our subscription first, then sends webhookSubscriptionCreate for APP_UNINSTALLED with our URL as `uri`", async () => {
    const calls = fakeShopify();
    expect(await subscribeUninstall(conn, "https://thakeen.test")).toBe(true);
    expect(SHOPIFY_HOOK_PATH).toBe("/api/shopify/compliance");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toMatch(/^https:\/\/a\.myshopify\.com\/admin\/api\/[^/]+\/graphql\.json$/);
      expect(c.token).toBe("shpat_SENTINEL");
    }
    expect(calls[0].query).toContain("webhookSubscriptions(first: 1, topics: [APP_UNINSTALLED], uri: $uri)");
    expect(calls[0].variables).toEqual({ uri: URI });
    expect(calls[1].query).toContain("webhookSubscriptionCreate(topic: APP_UNINSTALLED");
    expect(calls[1].variables).toEqual({ sub: { uri: URI } });
  });

  it("a store already subscribed to our URL answers true without a second subscription (rule 2204)", async () => {
    const calls = fakeShopify({ existing: ["a.myshopify.com"] });
    expect(await subscribeUninstall(conn, "https://thakeen.test")).toBe(true);
    expect(calls.map((c) => c.query.includes("webhookSubscriptionCreate"))).toEqual([false]);
  });

  it("false, never a throw, on userErrors, an HTTP error, a GraphQL error, a network failure or a bad shop", async () => {
    fakeShopify({ userErrors: [{ message: "invalid" }] });
    await expect(subscribeUninstall(conn, "https://thakeen.test")).resolves.toBe(false);
    const answers = [() => new Response("{}", { status: 500 }), () => Response.json({ errors: [{ message: "nope" }] }), () => { throw new Error("offline"); }];
    for (const a of answers) {
      vi.stubGlobal("fetch", vi.fn(async () => a()));
      await expect(subscribeUninstall(conn, "https://thakeen.test")).resolves.toBe(false);
    }
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(subscribeUninstall(shopConn("evil.example.com", "2026-10-18T00:00:00Z"), "https://thakeen.test")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the connect callback subscribes Shopify only, from the app's own origin, and saves the mark with the connection", () => {
    const src = readFileSync("src/app/api/connect/[provider]/callback/route.ts", "utf8");
    expect(src).toContain('if (p.id === "shopify" && (await subscribeUninstall(conn, origin))) meta[UNINSTALL_HOOK_META] = new Date().toISOString();');
    expect(src.indexOf("subscribeUninstall(conn, origin)")).toBeLessThan(src.lastIndexOf("await saveConnection(st.email, conn);"));
    expect(src).toContain("const origin = appOrigin();");
    expect(src.match(/subscribeUninstall\(/g)).toHaveLength(1);
    expect(UNINSTALL_HOOK_META).toBe("uninstallHook");
  });
});

describe("the stores cron subscribes the Shopify connections without the mark (rule 2204)", () => {
  const ORIGIN = "https://thakeen.test";

  it("subscribes unmarked stores and marks them; leaves marked, must-reconnect, Composio and other providers alone; a failure stays unmarked", async () => {
    const [old, marked, broken, composio, failing, woo] = await Promise.all(["hook-old", "hook-marked", "hook-broken", "hook-composio", "hook-failing", "hook-woo"].map((t) => newUser(t).then((u) => u.email)));
    const at = "2026-10-01T00:00:00.000Z";
    await Promise.all([
      saveConnection(old, shopConn("old.myshopify.com", at)),
      saveConnection(marked, { ...shopConn("marked.myshopify.com", at), meta: { shop: "marked.myshopify.com", [UNINSTALL_HOOK_META]: at } }),
      saveConnection(broken, { ...shopConn("broken.myshopify.com", at), needsReconnect: at }),
      saveConnection(composio, { ...shopConn("composio.myshopify.com", at), meta: { shop: "composio.myshopify.com", via: "composio" } }),
      saveConnection(failing, shopConn("failing.myshopify.com", at)),
      saveConnection(woo, { provider: "woocommerce", data: { site: "https://w.example" }, meta: { site: "https://w.example" }, connectedAt: at }),
    ]);
    const calls = fakeShopify({ fail: ["failing.myshopify.com"] });
    const now = new Date("2026-10-18T02:00:00.000Z");
    expect(await backfillUninstallHooks([old, marked, broken, composio, failing, woo], ORIGIN, now)).toEqual({ due: 2, subscribed: 1, failed: 1 });
    expect(new Set(calls.map((c) => new URL(c.url).host))).toEqual(new Set(["old.myshopify.com", "failing.myshopify.com"]));
    const kept = await getConnection(old, "shopify");
    expect(kept?.meta).toEqual({ shop: "old.myshopify.com", [UNINSTALL_HOOK_META]: now.toISOString() });
    expect(kept?.data.access_token).toBe("shpat_SENTINEL");
    expect(kept?.connectedAt).toBe(at);
    expect((await getConnection(failing, "shopify"))?.meta?.[UNINSTALL_HOOK_META]).toBeUndefined();
    // The next run only retries the failure.
    fakeShopify();
    expect(await backfillUninstallHooks([old, marked, broken, composio, failing, woo], ORIGIN, now)).toEqual({ due: 1, subscribed: 1, failed: 0 });
  });

  it("a reconnect while the store answers is never overwritten with the old grant", async () => {
    const ws = await newUser("hook-race").then((u) => u.email);
    await saveConnection(ws, shopConn("race.myshopify.com", "2026-10-01T00:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      if (init.body.includes("webhookSubscriptionCreate")) await saveConnection(ws, { ...shopConn("race.myshopify.com", "2026-10-18T01:00:00.000Z"), data: { access_token: "shpat_NEW" } });
      return init.body.includes("webhookSubscriptions(") ? Response.json({ data: { webhookSubscriptions: { nodes: [] } } }) : Response.json({ data: { webhookSubscriptionCreate: { userErrors: [] } } });
    }));
    expect(await backfillUninstallHooks([ws], ORIGIN)).toEqual({ due: 1, subscribed: 0, failed: 0 });
    const c = await getConnection(ws, "shopify");
    expect(c?.data.access_token).toBe("shpat_NEW");
    expect(c?.connectedAt).toBe("2026-10-18T01:00:00.000Z");
  });

  it("at most HOOKS_PER_RUN a run, six at a time, through the store helpers; the cron runs it before the count and the syncs", () => {
    expect(HOOKS_PER_RUN).toBe(30);
    const src = readFileSync("src/lib/connectors/shopify-compliance.ts", "utf8");
    expect(src).toContain("due.slice(0, HOOKS_PER_RUN)");
    expect(src).toMatch(/return ok \? \("subscribed" as const\) : \("failed" as const\);\n  \}, 6\);/);
    const cron = readFileSync("src/app/api/cron/stores/route.ts", "utf8");
    const at = cron.indexOf("backfillUninstallHooks(scopes, appOrigin(), now, now.getTime() + HOOKS_DEADLINE_MS)");
    expect(cron.indexOf("applyShopRedactions(scopes)")).toBeLessThan(at);
    expect(at).toBeLessThan(cron.indexOf("tallyConnections(scopes, now, kept, hooks)"));
    expect(at).toBeLessThan(cron.indexOf("runCronBatch({"));
    expect(cron).toMatch(/backfillUninstallHooks\(scopes, appOrigin\(\), now, now\.getTime\(\) \+ HOOKS_DEADLINE_MS\)\.catch\(/);
    expect(cron).toContain("uninstall_hooks: hooks");
  });
});

describe("stores that keep failing cannot take every run's slots (rule 2209)", () => {
  const ORIGIN = "https://thakeen.test";
  const at = "2026-10-01T00:00:00.000Z";

  it("a failure records the attempt's time on the same grant; a later success marks the store and clears it", async () => {
    const ws = await newUser("hook-tried").then((u) => u.email);
    await saveConnection(ws, shopConn("tried.myshopify.com", at));
    fakeShopify({ fail: ["tried.myshopify.com"] });
    const first = new Date("2026-10-18T02:00:00.000Z");
    expect(await backfillUninstallHooks([ws], ORIGIN, first)).toEqual({ due: 1, subscribed: 0, failed: 1 });
    const failed = await getConnection(ws, "shopify");
    expect(failed?.meta).toEqual({ shop: "tried.myshopify.com", [UNINSTALL_TRIED_META]: first.toISOString() });
    expect(failed?.connectedAt).toBe(at);
    expect(failed?.data.access_token).toBe("shpat_SENTINEL");
    fakeShopify();
    const second = new Date("2026-10-18T14:00:00.000Z");
    expect(await backfillUninstallHooks([ws], ORIGIN, second)).toEqual({ due: 1, subscribed: 1, failed: 0 });
    expect((await getConnection(ws, "shopify"))?.meta).toEqual({ shop: "tried.myshopify.com", [UNINSTALL_HOOK_META]: second.toISOString() });
  });

  it("never-tried stores come first, then the oldest attempt, so the store tried last waits when more are due than a run takes", async () => {
    const n = HOOKS_PER_RUN + 1;
    const tried = await Promise.all(Array.from({ length: n - 1 }, (_, i) => newUser(`hook-q${i}`).then((u) => u.email)));
    const fresh = await newUser("hook-fresh").then((u) => u.email);
    // Attempts one minute apart; the roster lists the fresh store last, the newest attempt first.
    const stamp = (i: number) => new Date(Date.parse("2026-10-10T00:00:00.000Z") + i * 60_000).toISOString();
    await Promise.all([
      ...tried.map((ws, i) => saveConnection(ws, { ...shopConn(`q${i}.myshopify.com`, at), meta: { shop: `q${i}.myshopify.com`, [UNINSTALL_TRIED_META]: stamp(i) } })),
      saveConnection(fresh, shopConn("fresh.myshopify.com", at)),
    ]);
    const calls = fakeShopify();
    const roster = [...[...tried].reverse(), fresh];
    expect(await backfillUninstallHooks(roster, ORIGIN, new Date("2026-10-18T02:00:00.000Z"))).toEqual({ due: n, subscribed: HOOKS_PER_RUN, failed: 0 });
    const hosts = new Set(calls.map((c) => new URL(c.url).host));
    expect(hosts.has("fresh.myshopify.com")).toBe(true);
    expect(hosts.has(`q${n - 2}.myshopify.com`)).toBe(false);
    expect(hosts.has("q0.myshopify.com")).toBe(true);
    expect((await getConnection(tried[n - 2], "shopify"))?.meta?.[UNINSTALL_TRIED_META]).toBe(stamp(n - 2));
  });
});
