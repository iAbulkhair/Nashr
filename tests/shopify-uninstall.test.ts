import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { applyShopRedactions, COMPLIANCE_TOPICS, isShopHookTopic, UNINSTALL_TOPIC } from "@/lib/connectors/shopify-compliance";
import { SHOPIFY_HOOK_PATH, subscribeUninstall } from "@/lib/connectors/shopify";
import * as route from "@/app/api/shopify/compliance/route";

/**
 * Rule 2203 (docs/system/tests/2160-integrations-panel-drift.md): Shopify tells us when a store uninstalls the app.
 * The connect callback subscribes `app/uninstalled` to the compliance URL, and the delivery puts the store on the
 * same pending list `shop/redact` uses, so the next stores run drops the dead connection instead of 48 hours later.
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

describe("subscribeUninstall: one mutation to the store, best effort (rule 2203)", () => {
  const conn = shopConn("a.myshopify.com", "2026-10-18T00:00:00Z");

  it("sends webhookSubscriptionCreate for APP_UNINSTALLED with our compliance URL as `uri`, to the store's own host", async () => {
    const calls: { url: string; body: { query: string; variables: { sub: { uri: string } } }; token: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), token: init.headers["X-Shopify-Access-Token"] });
      return new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [] } } }), { status: 200 });
    }));
    expect(await subscribeUninstall(conn, "https://thakeen.test")).toBe(true);
    expect(SHOPIFY_HOOK_PATH).toBe("/api/shopify/compliance");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/a\.myshopify\.com\/admin\/api\/[^/]+\/graphql\.json$/);
    expect(calls[0].token).toBe("shpat_SENTINEL");
    expect(calls[0].body.query).toContain("webhookSubscriptionCreate(topic: APP_UNINSTALLED");
    expect(calls[0].body.variables).toEqual({ sub: { uri: "https://thakeen.test/api/shopify/compliance" } });
  });

  it("false, never a throw, on userErrors, an HTTP error, a GraphQL error, a network failure or a bad shop", async () => {
    const answers = [
      () => new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [{ message: "Address for this topic has already been taken" }] } } })),
      () => new Response("{}", { status: 500 }),
      () => new Response(JSON.stringify({ errors: [{ message: "nope" }] })),
      () => { throw new Error("offline"); },
    ];
    for (const a of answers) {
      vi.stubGlobal("fetch", vi.fn(async () => a()));
      await expect(subscribeUninstall(conn, "https://thakeen.test")).resolves.toBe(false);
    }
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(subscribeUninstall(shopConn("evil.example.com", "2026-10-18T00:00:00Z"), "https://thakeen.test")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the connect callback subscribes after the save, for Shopify only, from the app's own origin", () => {
    const src = readFileSync("src/app/api/connect/[provider]/callback/route.ts", "utf8");
    expect(src).toContain('if (p.id === "shopify") await subscribeUninstall(conn, origin);');
    expect(src.indexOf("await saveConnection(st.email, conn);")).toBeLessThan(src.indexOf("subscribeUninstall(conn, origin)"));
    expect(src).toContain("const origin = appOrigin();");
    expect(src.match(/subscribeUninstall\(/g)).toHaveLength(1);
  });
});
