import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { readFile, writeFile } from "@/lib/files";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { dropSnapshotIfStoreChanged, getSalesSnapshot, storeIdentity } from "@/lib/store-sales";
import * as keyRoute from "@/app/api/connect/[provider]/key/route";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rule 2207 (docs/system/tests/2160-integrations-panel-drift.md): connecting the same platform to another store drops
 * the old store's sales snapshot, failure note and store-sales.md, so the reports never show one store's totals under
 * another's name. The same store again, an unknown store on either side or another platform's snapshot: kept.
 */

const at = "2026-10-18T00:00:00.000Z";
const conn = (provider: string, meta: Record<string, string>): Connection => ({ provider, data: { access_token: "SENTINEL-token" }, meta, connectedAt: at });
const snap = (provider: string) => ({ provider, at, days: 30, orders: { count: 1, read: 1, canceled: 0, revenue: { SAR: 10 }, top: [] }, carts: { count: 0, value: {}, top: [] }, unread: 0 });

async function withSnapshot(tag: string, c: Connection) {
  const u = await newUser(tag);
  const scope = sc(u);
  await Promise.all([
    saveConnection(scope, c),
    db.set(`storesales:${scope}`, snap(c.provider)),
    db.set(`storesyncfail:${scope}`, { provider: c.provider, at, error: "x" }),
    writeFile(scope, "store-sales.md", "# sales", "noor"),
    writeFile(scope, "products.md", "# products", "noor"),
  ]);
  return { u, scope };
}

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("storeIdentity (rule 2207)", () => {
  it("names the store each connect step stored, and nothing for a platform that is not a store", () => {
    expect(storeIdentity(conn("shopify", { shop: "a.myshopify.com" }))).toBe("a.myshopify.com");
    expect(storeIdentity(conn("zid", { storeId: "1234", account: "Zid Store" }))).toBe("1234");
    expect(storeIdentity(conn("salla", { site: "https://Demo.Salla.sa/" }))).toBe(storeIdentity(conn("salla", { site: "demo.salla.sa" })));
    expect(storeIdentity(conn("woocommerce", { site: "https://shop.example.com/" }))).toBe("shop.example.com");
    expect(storeIdentity(conn("salla", { account: "Name only" }))).toBe("");
    expect(storeIdentity(conn("wordpress", { site: "https://blog.example.com" }))).toBe("");
    expect(storeIdentity({ provider: "shopify" })).toBe("");
  });
});

describe("dropSnapshotIfStoreChanged (rule 2207)", () => {
  it("another store of the same platform drops the old store's totals and keeps products.md", async () => {
    const { scope } = await withSnapshot("recon-other", conn("shopify", { shop: "a.myshopify.com" }));
    expect(await dropSnapshotIfStoreChanged(scope, conn("shopify", { shop: "a.myshopify.com" }), conn("shopify", { shop: "b.myshopify.com" }))).toBe(true);
    expect(await getSalesSnapshot(scope)).toBeNull();
    expect(await db.get(`storesyncfail:${scope}`)).toBeNull();
    expect(await readFile(scope, "store-sales.md")).toBeFalsy();
    expect(await readFile(scope, "products.md")).toBeTruthy();
  });

  it("the same store again, an unknown store on either side, no earlier connection or another platform: nothing goes", async () => {
    const { scope } = await withSnapshot("recon-same", conn("shopify", { shop: "a.myshopify.com" }));
    const a = conn("shopify", { shop: "a.myshopify.com" });
    expect(await dropSnapshotIfStoreChanged(scope, a, conn("shopify", { shop: "A.myshopify.com" }))).toBe(false);
    expect(await dropSnapshotIfStoreChanged(scope, conn("shopify", {}), conn("shopify", { shop: "b.myshopify.com" }))).toBe(false);
    expect(await dropSnapshotIfStoreChanged(scope, a, conn("shopify", {}))).toBe(false);
    expect(await dropSnapshotIfStoreChanged(scope, null, conn("shopify", { shop: "b.myshopify.com" }))).toBe(false);
    // A Zid store change, while the snapshot is Shopify's: dropSalesSnapshot keeps another platform's snapshot.
    expect(await dropSnapshotIfStoreChanged(scope, conn("zid", { storeId: "1" }), conn("zid", { storeId: "2" }))).toBe(false);
    expect((await getSalesSnapshot(scope))?.provider).toBe("shopify");
  });
});

describe("the connect steps call it with the caller's own scope (rule 2207)", () => {
  it("WooCommerce: a key for another site drops the old site's totals; the same site again keeps them", async () => {
    const { u, scope } = await withSnapshot("recon-woo", { provider: "woocommerce", data: { site: "https://one.example.com", consumerKey: "ck", consumerSecret: "cs" }, meta: { site: "https://one.example.com" }, connectedAt: at });
    await signIn(u.email);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const post = (site: string) => keyRoute.POST(json("/api/connect/woocommerce/key", "POST", { site, consumerKey: "ck_SENTINEL", consumerSecret: "cs_SENTINEL" }), params({ provider: "woocommerce" }));
    expect((await post("https://one.example.com")).status).toBe(200);
    expect((await getSalesSnapshot(scope))?.provider).toBe("woocommerce");
    expect((await post("https://two.example.com")).status).toBe(200);
    expect(await getSalesSnapshot(scope)).toBeNull();
    expect(await readFile(scope, "products.md")).toBeTruthy();
    expect((await getConnection(scope, "woocommerce"))?.meta?.site).toBe("https://two.example.com");
  });

  it("the OAuth callback reads the earlier connection before the save and drops after it", () => {
    const src = readFileSync("src/app/api/connect/[provider]/callback/route.ts", "utf8");
    const before = src.indexOf("const before = storeIdentity(conn) ? await getConnection(st.email, p.id).catch(() => null) : null;");
    const save = src.lastIndexOf("await saveConnection(st.email, conn);");
    const drop = src.indexOf("await dropSnapshotIfStoreChanged(st.email, before, conn);");
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(save);
    expect(save).toBeLessThan(drop);
    const key = readFileSync("src/app/api/connect/[provider]/key/route.ts", "utf8");
    expect(key).toContain("await dropSnapshotIfStoreChanged(sc(u), before, conn);");
    expect(key.indexOf('forbid(u, "connectors")')).toBeLessThan(key.indexOf("dropSnapshotIfStoreChanged("));
  });
});
