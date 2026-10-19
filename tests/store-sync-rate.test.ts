import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { currentUser, sc } from "@/lib/auth";
import { globalKey, wsKey } from "@/lib/keys";
import { CATALOG_IMPORTS_PER_HOUR, STORE_SYNCS_PER_HOUR } from "@/lib/rate";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { connectError } from "@/lib/connect-errors";
import * as connectRoute from "@/app/api/connect/[provider]/route";
import * as catalogRoute from "@/app/api/catalog/route";
import { runTool } from "@/lib/chat-run-tool";

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

/**
 * Rule 2249: the no-key catalog import (the Files page's POST /api/catalog and chat's import_catalog) reads up to some
 * forty pages of a site the caller names, so it shares the product import's bucket: six an hour per workspace, whichever
 * way it was started. Over the limit nothing is fetched and products.md is not touched.
 */
describe("the no-key catalog import shares the product import's six an hour (rule 2249)", () => {
  const catalog = () => catalogRoute.POST(json("/api/catalog", "POST", { url: "https://shop.example" }));

  it("the Files page's import is refused with 429 slow_down once the workspace's six are spent, and fetches nothing", async () => {
    const u = await newUser("catalograte");
    await signIn(u.email);
    const site = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", site);
    for (let i = 0; i < CATALOG_IMPORTS_PER_HOUR; i++) {
      const r = await catalog();
      expect(r.status).toBe(200);
      await r.text();
    }
    const seen = site.mock.calls.length;
    const refused = await catalog();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("3600");
    expect(await refused.json()).toEqual({ ok: false, error: "slow_down" });
    expect(site.mock.calls.length).toBe(seen);
  });

  it("one bucket: store imports spend the Files page's and chat's allowance, and chat says why it did nothing", async () => {
    const u = await newUser("catalograte-chat");
    await saveConnection(sc(u), salla());
    await signIn(u.email);
    emptyStore();
    for (let i = 0; i < CATALOG_IMPORTS_PER_HOUR; i++) expect((await act("import_products")).status).toBe(200);
    expect((await catalog()).status).toBe(429);
    const site = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", site);
    const actions: string[] = [];
    // The owner names the shop in their own message, so the host gate (rule 2304) lets it through to the shared bucket.
    const said = await runTool((await currentUser())!, "import_catalog", { url: "https://shop.example" }, actions, [], undefined, { via: "app", ownerMsg: "import my products from shop.example" });
    expect(said).toContain("six times in the last hour");
    expect(actions).toEqual([]);
    expect(site).not.toHaveBeenCalled();
  });

  it("a request without a site, or from a role that may not import, costs nothing; the Files page shows the slow_down words", async () => {
    const u = await newUser("catalograte-free");
    const m = await newMember(u, "member");
    await signIn(m.email);
    expect((await catalog()).status).toBe(403);
    signOut();
    await signIn(u.email);
    expect((await catalogRoute.POST(json("/api/catalog", "POST", {}))).status).toBe(400);
    expect(await db.get(globalKey.rate(wsKey.catalogImportBucket(sc(u))))).toBeNull();
    const panel = readFileSync("src/components/app/FilesPanel.tsx", "utf8");
    expect(panel).toContain('res?.status === 429) toast.danger(connectError(lang, "slow_down"))');
  });
});
