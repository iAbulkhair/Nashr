import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { globalKey, wsKey } from "@/lib/keys";
import { CATALOG_IMPORTS_PER_HOUR, STORE_SYNCS_PER_HOUR } from "@/lib/rate";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { connectError } from "@/lib/connect-errors";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 2243 (docs/system/tests/2240-key-check-rate.md): a manual sales sync (any member) and a product import each read
 * pages from the store, so each is limited to six an hour per workspace, every store together. Over the limit the route
 * answers 429 `slow_down` with `Retry-After` and asks the store nothing. The stores cron calls syncSales itself and is
 * not counted.
 */

const salla = (): Connection => ({ provider: "salla", data: { access_token: "tok", refresh_token: "r" }, meta: { account: "Store" }, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 864e5).toISOString() });
const act = (action: string, provider = "salla") => connectRoute.POST(json(`/api/connect/${provider}`, "POST", { action }), params({ provider }));
/** A Salla store with nothing in it: every list is one empty page. */
function emptyStore() {
  const spy = vi.fn(async () => Response.json({ data: [], pagination: { currentPage: 1, totalPages: 1, total: 0 } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("manual store syncs and product imports are limited per workspace (rule 2243)", () => {
  it("six sales syncs an hour, then 429 slow_down with Retry-After and the store is not asked", async () => {
    const u = await newUser("storesync");
    await saveConnection(sc(u), salla());
    await signIn(u.email);
    const store = emptyStore();
    for (let i = 0; i < STORE_SYNCS_PER_HOUR; i++) expect((await act("sync_sales")).status).toBe(200);
    const seen = store.mock.calls.length;
    expect(seen).toBeGreaterThan(0);
    const refused = await act("sync_sales");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("3600");
    expect(await refused.json()).toEqual({ ok: false, error: "slow_down" });
    expect(store.mock.calls.length).toBe(seen);
  });

  it("six product imports an hour in their own bucket: a spent sync allowance does not block an import", async () => {
    const u = await newUser("catalogimport");
    await saveConnection(sc(u), salla());
    await signIn(u.email);
    await db.set(globalKey.rate(wsKey.storeSyncBucket(sc(u))), STORE_SYNCS_PER_HOUR, 3600);
    const store = emptyStore();
    for (let i = 0; i < CATALOG_IMPORTS_PER_HOUR; i++) expect((await act("import_products")).status).toBe(200);
    const seen = store.mock.calls.length;
    const refused = await act("import_products");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ ok: false, error: "slow_down" });
    expect(store.mock.calls.length).toBe(seen);
    expect((await act("sync_sales")).status).toBe(429);
  });

  it("a member's syncs count for the whole team, and another workspace keeps its allowance", async () => {
    const a = await newUser("storesync-a");
    const b = await newUser("storesync-b");
    await Promise.all([saveConnection(sc(a), salla()), saveConnection(sc(b), salla())]);
    const m = await newMember(a, "member");
    await signIn(m.email);
    emptyStore();
    for (let i = 0; i < STORE_SYNCS_PER_HOUR; i++) expect((await act("sync_sales")).status).toBe(200);
    signOut();
    await signIn(a.email);
    expect((await act("sync_sales")).status).toBe(429);
    signOut();
    await signIn(b.email);
    expect((await act("sync_sales")).status).toBe(200);
  });

  it("a refused role, a missing connection or a store without sales costs nothing", async () => {
    const u = await newUser("storesync-free");
    await signIn(u.email);
    emptyStore();
    expect((await act("sync_sales")).status).toBe(404);
    await saveConnection(sc(u), { provider: "prestashop", data: { site: "https://p.example", apiKey: "k" }, connectedAt: new Date().toISOString() });
    expect((await act("sync_sales", "prestashop")).status).toBe(400);
    const m = await newMember(u, "member");
    signOut();
    await signIn(m.email);
    expect((await act("import_products", "prestashop")).status).toBe(403);
    const [sync, imp] = await Promise.all([db.get(globalKey.rate(wsKey.storeSyncBucket(sc(u)))), db.get(globalKey.rate(wsKey.catalogImportBucket(sc(u))))]);
    expect([sync, imp]).toEqual([null, null]);
  });

  it("the route takes the hit before the store is read, and the sales card shows the slow_down words", () => {
    const src = readFileSync("src/app/api/connect/[provider]/route.ts", "utf8");
    const imp = src.indexOf("allow(wsKey.catalogImportBucket(sc(u)), CATALOG_IMPORTS_PER_HOUR, WINDOW.hour)");
    const sync = src.indexOf("allow(wsKey.storeSyncBucket(sc(u)), STORE_SYNCS_PER_HOUR, WINDOW.hour)");
    expect(imp).toBeGreaterThan(src.indexOf('if (b.action === "import_products")'));
    expect(imp).toBeLessThan(src.indexOf("await importShopify(sc(u), c)"));
    expect(sync).toBeGreaterThan(src.indexOf('if (b.action === "sync_sales"'));
    expect(sync).toBeLessThan(src.indexOf("await syncSales(sc(u), provider as SalesProvider, c)"));
    expect([STORE_SYNCS_PER_HOUR, CATALOG_IMPORTS_PER_HOUR]).toEqual([6, 6]);
    const panel = readFileSync("src/components/app/ReportsPanel.tsx", "utf8");
    expect(panel).toContain('j.error === "slow_down" ? connectError(lang, j.error)');
    expect(connectError("en", "slow_down")).toBe("Too many tries. Wait a little, then try again.");
  });
});
