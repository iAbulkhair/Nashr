import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { readFile, writeFile } from "@/lib/files";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { applyShopRedactions, COMPLIANCE_SHOWN, COMPLIANCE_TOPICS, complianceSummary, recordCompliance, validShopifyWebhook } from "@/lib/connectors/shopify-compliance";
import { integrationsView } from "@/lib/integration-status";
import { adminSignIn, json, signOut } from "./helpers/session";
import * as integrationsRoute from "@/app/api/admin/integrations/route";
import { existsSync } from "node:fs";
import * as route from "@/app/api/shopify/compliance/route";

/**
 * Shopify's mandatory compliance webhooks (rules 2168-2171, docs/system/tests/2160-integrations-panel-drift.md): one
 * public URL, nothing trusted before the HMAC, receipts without customer data, and `shop/redact` applied by the stores
 * cron from its own roster, never from a key the request names.
 */

const SECRET = "SENTINEL-shopify-app-secret";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
let ip = 0;
const post = (body: string, headers: Record<string, string> = {}) =>
  route.POST(new Request("https://thakeen.test/api/shopify/compliance", { method: "POST", body, headers: { "content-type": "application/json", "x-forwarded-for": `10.21.${++ip % 250}.${ip % 250}`, ...headers } }));
const delivery = (topic: string, payload: Record<string, unknown>, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return post(body, { "x-shopify-topic": topic, "x-shopify-hmac-sha256": sign(body, secret) });
};
const CUSTOMER = { id: 191167, email: "SENTINEL-buyer@example.com", phone: "+966500000001" };
const src = () => readFileSync("src/app/api/shopify/compliance/route.ts", "utf8");
const log = async () => (await db.lrange(globalKey.shopifyCompliance(), 0, -1)).map((r) => JSON.parse(r) as Record<string, unknown>);

beforeEach(async () => {
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  await Promise.all([db.del(globalKey.shopifyCompliance()), db.del(globalKey.shopifyRedact())]);
});
afterEach(() => vi.unstubAllEnvs());

describe("one public URL, nothing trusted before the HMAC (rule 2168)", () => {
  it("validShopifyWebhook takes only the base64 HMAC-SHA256 of the exact raw body under the app secret", () => {
    const body = '{"shop_domain":"a.myshopify.com"}';
    expect(validShopifyWebhook(body, sign(body), SECRET)).toBe(true);
    expect(validShopifyWebhook(body + " ", sign(body), SECRET)).toBe(false);
    expect(validShopifyWebhook(body, sign(body, "other"), SECRET)).toBe(false);
    expect(validShopifyWebhook(body, createHmac("sha256", SECRET).update(body).digest("hex"), SECRET)).toBe(false);
    expect(validShopifyWebhook(body, null, SECRET)).toBe(false);
    expect(validShopifyWebhook(body, sign(body, ""), undefined)).toBe(false);
  });

  it("401 without a signature, with a wrong one, or while SHOPIFY_CLIENT_SECRET is unset; nothing is kept", async () => {
    const payload = { shop_id: 1, shop_domain: "a.myshopify.com" };
    expect((await post(JSON.stringify(payload), { "x-shopify-topic": "shop/redact" })).status).toBe(401);
    expect((await delivery("shop/redact", payload, "wrong-secret")).status).toBe(401);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect((await delivery("shop/redact", payload, "")).status).toBe(401);
    expect(await log()).toEqual([]);
    expect(await db.hgetall(globalKey.shopifyRedact())).toEqual({});
  });

  it("413 past 64 KB; 400 for signed JSON that is broken or names no real store; a signed other topic is acknowledged and dropped", async () => {
    const big = JSON.stringify({ shop_domain: "a.myshopify.com", pad: "x".repeat(70 * 1024) });
    expect((await post(big, { "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": sign(big) })).status).toBe(413);
    const broken = "{not json";
    expect((await post(broken, { "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": sign(broken) })).status).toBe(400);
    for (const shop_domain of ["evil.example.com", "a.myshopify.com.evil.com", 7]) expect((await delivery("shop/redact", { shop_domain })).status).toBe(400);
    const other = await delivery("orders/create", { shop_domain: "a.myshopify.com" });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ ok: true, ignored: true });
    expect(await log()).toEqual([]);
  });

  it("the route checks the signature before it parses the body, and is exempt from the cross-site check by its exact path", () => {
    const src = readFileSync("src/app/api/shopify/compliance/route.ts", "utf8");
    expect(src.indexOf("validShopifyWebhook(raw")).toBeGreaterThan(0);
    expect(src.indexOf("validShopifyWebhook(raw")).toBeLessThan(src.indexOf("JSON.parse(raw)"));
    expect(src).toContain('allow("shopifyhook:ip:" + clientIp(req)');
    expect(readFileSync("src/lib/csrf.ts", "utf8")).toContain('"/api/shopify/compliance",');
  });

  it("the founder's current values give Shopify this URL for all three fields, and no new key name", () => {
    const doc = readFileSync("docs/Registration_Packs.md", "utf8");
    const current = doc.slice(doc.indexOf("## Current values"), doc.indexOf("Written 2026-09-27"));
    expect(current).toContain("`https://thakeen.com/api/shopify/compliance`");
    expect(current).toMatch(/Compliance webhooks[\s\S]{0,200}all three fields/);
    expect(src()).toContain("process.env.SHOPIFY_CLIENT_SECRET");
  });
});

describe("customer topics keep no customer data (rule 2169)", () => {
  it.each(["customers/data_request", "customers/redact"])("%s answers 200 and logs topic, store and time only", async (topic) => {
    const r = await delivery(topic, { shop_id: 1, shop_domain: "A.myshopify.com", customer: CUSTOMER, orders_requested: [299938], orders_to_redact: [299938], data_request: { id: 9999 } });
    expect(r.status).toBe(200);
    const rows = await log();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["at", "shop", "topic"]);
    expect(rows[0]).toMatchObject({ topic, shop: "a.myshopify.com" });
    const raw = JSON.stringify(rows);
    for (const v of [CUSTOMER.email, CUSTOMER.phone, String(CUSTOMER.id), "299938", "9999"]) expect(raw).not.toContain(v);
    expect(await db.hgetall(globalKey.shopifyRedact())).toEqual({});
  });

  it("the queries the receipts rely on still ask Shopify for no customer field", () => {
    const src = readFileSync("src/lib/connectors/shopify.ts", "utf8");
    const queries = [...src.matchAll(/const [A-Z_]+ = `(query[\s\S]*?)`;/g)].map((m) => m[1]).join("\n");
    expect(queries).toMatch(/orders\(/);
    expect(queries).not.toMatch(/\b(customer|email|phone|billingAddress|shippingAddress|displayName)\b/);
  });
});

describe("shop/redact is queued under a fixed key (rule 2170)", () => {
  it("records the store with its time; a retried delivery only moves the time", async () => {
    expect((await delivery("shop/redact", { shop_id: 1, shop_domain: "a.myshopify.com" })).status).toBe(200);
    const first = await db.hgetall<string>(globalKey.shopifyRedact());
    expect(Object.keys(first)).toEqual(["a.myshopify.com"]);
    await recordCompliance("shop/redact", { shop_domain: "a.myshopify.com" }, new Date(Date.now() + 60_000));
    const again = await db.hgetall<string>(globalKey.shopifyRedact());
    expect(Object.keys(again)).toEqual(["a.myshopify.com"]);
    expect(Date.parse(again["a.myshopify.com"])).toBeGreaterThan(Date.parse(first["a.myshopify.com"]));
  });

  it("the module builds no key from the payload: only the two fixed global keys, and workspace helpers with the roster's scope", () => {
    const src = readFileSync("src/lib/connectors/shopify-compliance.ts", "utf8");
    expect(COMPLIANCE_TOPICS).toEqual(["customers/data_request", "customers/redact", "shop/redact"]);
    // Every store call of its own names one of the two fixed keys first.
    const calls = [...src.matchAll(/\b(?:db\.\w+|pushCapped)\(/g)].length;
    const keys = [...src.matchAll(/\b(?:db\.\w+|pushCapped)\((globalKey\.\w+\(\))/g)].map((m) => m[1]);
    expect(keys).toHaveLength(calls);
    expect(new Set(keys)).toEqual(new Set(["globalKey.shopifyCompliance()", "globalKey.shopifyRedact()"]));
    // Workspace data goes only through the helpers that take the scope they were handed.
    expect(src).toContain('Promise.all([deleteConnection(scope, "shopify"), dropSalesSnapshot(scope, "shopify")])');
    expect(src).not.toMatch(/`[^`]*\$\{shop\}[^`]*`/);
  });
});

describe("the stores cron applies shop/redact from its own roster (rule 2171)", () => {
  const conn = (shop: string, connectedAt: string): Connection => ({ provider: "shopify", data: { access_token: "shpat_SENTINEL" }, meta: { shop }, connectedAt });

  it("drops the connection, the Shopify snapshot and store-sales.md of each workspace on that store that connected before the request", async () => {
    const before = new Date(Date.now() - 3 * 86400e3).toISOString();
    const [gone, other, again, woo] = await Promise.all(["redact-a", "redact-b", "redact-c", "redact-d"].map((t) => newUser(t).then((u) => u.email)));
    await Promise.all([
      saveConnection(gone, conn("a.myshopify.com", before)),
      saveConnection(other, conn("b.myshopify.com", before)),
      // Connected again after the store's uninstall: a new grant, kept.
      saveConnection(again, conn("a.myshopify.com", new Date(Date.now() + 60_000).toISOString())),
      saveConnection(woo, { provider: "woocommerce", data: { site: "https://w.example" }, meta: { site: "https://w.example" }, connectedAt: before }),
      db.set(`storesales:${gone}`, { provider: "shopify", at: before }),
      db.set(`storesyncfail:${gone}`, { provider: "shopify", at: before, error: "x" }),
      writeFile(gone, "store-sales.md", "# sales", "noor"),
      writeFile(gone, "products.md", "# products", "noor"),
      db.set(`storesales:${other}`, { provider: "shopify", at: before }),
    ]);
    await recordCompliance("shop/redact", { shop_domain: "a.myshopify.com" });

    expect(await applyShopRedactions([gone, other, again, woo])).toBe(1);
    expect(await getConnection(gone, "shopify")).toBeNull();
    expect(await db.smembers(`conns:${gone}`)).not.toContain("shopify");
    expect(await db.get(`storesales:${gone}`)).toBeNull();
    expect(await db.get(`storesyncfail:${gone}`)).toBeNull();
    expect(await readFile(gone, "store-sales.md")).toBeFalsy();
    // The owner's own catalog file stays: it is theirs to keep or delete.
    expect(await readFile(gone, "products.md")).toBeTruthy();
    expect(await getConnection(other, "shopify")).not.toBeNull();
    expect(await db.get(`storesales:${other}`)).not.toBeNull();
    expect(await getConnection(again, "shopify")).not.toBeNull();
    expect(await getConnection(woo, "woocommerce")).not.toBeNull();

    expect(await db.hgetall(globalKey.shopifyRedact())).toEqual({});
    expect((await log()).find((r) => r.topic === "shop/redact:done")).toMatchObject({ shop: "a.myshopify.com", workspaces: 1 });
    // Nothing pending: nothing read, nothing done.
    expect(await applyShopRedactions([gone, other, again, woo])).toBe(0);
  });

  it("the cron runs it over active and idle workspaces before any sync, and a failed pass does not stop the syncs", () => {
    const src = readFileSync("src/app/api/cron/stores/route.ts", "utf8");
    expect(src).toContain("applyShopRedactions([...users.map((u) => sc(u)), ...idle])");
    expect(src.indexOf("applyShopRedactions(")).toBeLessThan(src.indexOf("runCronBatch({"));
    expect(src).toMatch(/applyShopRedactions\([^;]*\.catch\(/);
    expect(src).toContain("shop_redactions: shopRedactions");
  });
});

describe("the Integrations page gives the founder the webhook URL and the receipts (rules 2172-2173)", () => {
  it("the Shopify row lists /api/shopify/compliance as its webhook, every listed webhook is a route of ours, no other row has one", () => {
    const rows = integrationsView({});
    expect(rows.find((r) => r.id === "shopify")?.webhooks).toEqual(["/api/shopify/compliance"]);
    for (const r of rows) for (const w of r.webhooks) expect(existsSync(`src/app${w}/route.ts`), w).toBe(true);
    expect(rows.filter((r) => r.webhooks.length).map((r) => r.id)).toEqual(["shopify"]);
    expect(readFileSync("src/components/admin/IntegrationsPanel.tsx", "utf8")).toContain("data-testid={`integration-${i.id}-webhooks`}");
  });

  it("complianceSummary: the stores still pending, oldest first, and the newest receipts; a broken row is left out", async () => {
    expect(await complianceSummary()).toEqual({ pending: [], recent: [] });
    const t0 = new Date("2026-10-18T08:00:00.000Z");
    await recordCompliance("customers/data_request", { shop_domain: "a.myshopify.com", customer: CUSTOMER }, t0);
    await recordCompliance("shop/redact", { shop_domain: "b.myshopify.com" }, new Date("2026-10-18T09:00:00.000Z"));
    await recordCompliance("shop/redact", { shop_domain: "c.myshopify.com" }, new Date("2026-10-18T07:00:00.000Z"));
    await db.lpush(globalKey.shopifyCompliance(), "{broken");
    await db.lpush(globalKey.shopifyCompliance(), JSON.stringify({ topic: "shop/redact", shop: "evil.example.com", at: "x" }));
    const s = await complianceSummary();
    expect(s.pending).toEqual([{ shop: "c.myshopify.com", at: "2026-10-18T07:00:00.000Z" }, { shop: "b.myshopify.com", at: "2026-10-18T09:00:00.000Z" }]);
    expect(s.recent.map((r) => [r.topic, r.shop])).toEqual([["shop/redact", "c.myshopify.com"], ["shop/redact", "b.myshopify.com"], ["customers/data_request", "a.myshopify.com"]]);
    expect(JSON.stringify(s)).not.toContain(CUSTOMER.email);
    for (let n = 0; n < COMPLIANCE_SHOWN + 5; n++) await recordCompliance("customers/redact", { shop_domain: "d.myshopify.com" });
    expect((await complianceSummary()).recent).toHaveLength(COMPLIANCE_SHOWN);
  });

  it("GET /api/admin/integrations carries the summary to a founder only, and still loads when the store read fails", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-shopify-compliance");
    await recordCompliance("shop/redact", { shop_domain: "a.myshopify.com" });
    expect((await integrationsRoute.GET(json("/api/admin/integrations", "GET"))).status).toBe(401);
    await adminSignIn();
    try {
      const body = (await (await integrationsRoute.GET(json("/api/admin/integrations", "GET"))).json()) as { shopifyCompliance: { pending: { shop: string }[] } };
      expect(body.shopifyCompliance.pending.map((p) => p.shop)).toEqual(["a.myshopify.com"]);
      const fail = vi.spyOn(db, "hgetall").mockRejectedValueOnce(new Error("down"));
      const down = await integrationsRoute.GET(json("/api/admin/integrations", "GET"));
      fail.mockRestore();
      expect(down.status).toBe(200);
      expect(((await down.json()) as { shopifyCompliance: unknown; items: unknown[] })).toMatchObject({ shopifyCompliance: null });
      const r = readFileSync("src/app/api/admin/integrations/route.ts", "utf8");
      expect(r.indexOf("adminActor(req)")).toBeLessThan(r.indexOf("complianceSummary()"));
    } finally {
      signOut();
    }
  });
});
