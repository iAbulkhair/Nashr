import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { readFile, writeFile } from "@/lib/files";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { getSalesSnapshot } from "@/lib/store-sales";
import * as connRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 2206 (docs/system/tests/2160-integrations-panel-drift.md): disconnecting a store drops the sales snapshot, its
 * failure note and store-sales.md when they came from that store's platform, as X's read goes with X (rule 747), so
 * Dana never reports on a store that is gone. The owner's products.md stays; another platform's snapshot stays.
 */

const at = "2026-10-18T00:00:00.000Z";
const conn = (provider: string, meta: Record<string, string>): Connection => ({ provider, data: { access_token: "SENTINEL-token" }, meta, connectedAt: at });
const snap = (provider: string) => ({ provider, at, days: 30, orders: { count: 1, read: 1, canceled: 0, revenue: { SAR: 10 }, top: [] }, carts: { count: 0, value: {}, top: [] }, unread: 0 });
const del = (provider: string) => connRoute.DELETE(json(`/api/connect/${provider}`, "DELETE"), params({ provider }));

async function storeWorkspace(tag: string, provider: string) {
  const u = await newUser(tag);
  const scope = sc(u);
  await Promise.all([
    saveConnection(scope, conn(provider, provider === "shopify" ? { shop: "a.myshopify.com" } : { site: "https://shop.example.com" })),
    db.set(`storesales:${scope}`, snap(provider)),
    db.set(`storesyncfail:${scope}`, { provider, at, error: "x" }),
    writeFile(scope, "store-sales.md", "# sales", "noor"),
    writeFile(scope, "products.md", "# products", "noor"),
  ]);
  await signIn(u.email);
  return { u, scope };
}

afterEach(() => signOut());

describe("a store's sales data goes with its connection (rule 2206)", () => {
  it("DELETE of the store drops the snapshot, the failure note and store-sales.md, and keeps products.md", async () => {
    for (const provider of ["shopify", "woocommerce", "salla", "zid"]) {
      const { scope } = await storeWorkspace(`disc-${provider}`, provider);
      expect((await del(provider)).status).toBe(200);
      expect(await getConnection(scope, provider)).toBeNull();
      expect(await getSalesSnapshot(scope)).toBeNull();
      expect(await db.get(`storesyncfail:${scope}`)).toBeNull();
      expect(await readFile(scope, "store-sales.md")).toBeFalsy();
      expect(await readFile(scope, "products.md")).toBeTruthy();
      signOut();
    }
  });

  it("disconnecting another platform, or a store the snapshot did not come from, leaves the snapshot", async () => {
    const { scope } = await storeWorkspace("disc-other", "shopify");
    await saveConnection(scope, conn("woocommerce", { site: "https://w.example" }));
    await saveConnection(scope, conn("x", { account: "@a" }));
    expect((await del("woocommerce")).status).toBe(200);
    expect((await del("x")).status).toBe(200);
    expect((await getSalesSnapshot(scope))?.provider).toBe("shopify");
    expect(await readFile(scope, "store-sales.md")).toBeTruthy();
    expect(await getConnection(scope, "shopify")).not.toBeNull();
  });

  it("a member without the connectors role is refused before anything is dropped", async () => {
    const { u, scope } = await storeWorkspace("disc-member", "shopify");
    const m = await newMember(u, "member");
    await signIn(m.email);
    expect((await del("shopify")).status).toBe(403);
    expect((await getSalesSnapshot(scope))?.provider).toBe("shopify");
    expect(await getConnection(scope, "shopify")).not.toBeNull();
  });

  it("the route drops it beside the connection, through dropSalesSnapshot with the caller's own scope", () => {
    const src = readFileSync("src/app/api/connect/[provider]/route.ts", "utf8");
    expect(src).toContain("isSalesProvider(provider) ? dropSalesSnapshot(sc(u), provider) : null");
    expect(src.indexOf('forbid(u, "connectors")')).toBeLessThan(src.indexOf("dropSalesSnapshot(sc(u), provider)"));
  });
});

describe("the owner is told before saying yes (rule 2206)", () => {
  it("the disconnect confirm of a store says its sales totals leave the reports, in both languages", () => {
    const src = readFileSync("src/components/app/IntegrationsPanel.tsx", "utf8");
    expect(src).toContain("(SALES_PROVIDERS as readonly string[]).includes(id)");
    expect(src).toContain("the store's sales totals leave your reports until you connect it again and sync.");
    expect(src).toContain("وتُحذف أرقام مبيعات المتجر من التقارير حتى تربطه من جديد وتزامن.");
  });
});
