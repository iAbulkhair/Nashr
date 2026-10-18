import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { backfillUninstallHooks, recordCompliance } from "@/lib/connectors/shopify-compliance";
import * as storesCron from "@/app/api/cron/stores/route";

/**
 * Rule 2208 (docs/system/tests/2160-integrations-panel-drift.md): the stores cron's passes before the syncs run on the
 * first hop only, the Shopify subscription pass starts no store after its deadline, and the syncs' start budget counts
 * from the request's start, so slow platforms can never push the syncs past the function's limit.
 */

const shopConn = (shop: string, connectedAt = "2026-10-01T00:00:00.000Z"): Connection => ({ provider: "shopify", data: { access_token: "shpat_SENTINEL" }, meta: { shop }, connectedAt });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the Shopify subscription pass has a deadline (rule 2208)", () => {
  it("past the deadline no store is started: nothing is asked, nothing is marked, all stay due", async () => {
    const ws = await newUser("budget-late").then((u) => u.email);
    await saveConnection(ws, shopConn("late.myshopify.com"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await backfillUninstallHooks([ws], "https://thakeen.test", new Date(), Date.now() - 1)).toEqual({ due: 1, subscribed: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getConnection(ws, "shopify"))?.meta?.uninstallHook).toBeUndefined();
  });
});

describe("a chained hop only continues the syncs (rule 2208)", () => {
  const call = (q = "") => storesCron.GET(new Request(`https://thakeen.test/api/cron/stores${q}`, { headers: { authorization: "Bearer cron-secret-budget" } }));

  it("on a later hop no redaction, keep-alive, subscription or count runs, and the answer leaves them out", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-budget");
    const gone = await newUser("budget-hop").then((u) => u.email);
    await Promise.all([db.del(globalKey.shopifyRedact()), db.del(globalKey.connectionHealth())]);
    await saveConnection(gone, shopConn("hop.myshopify.com"));
    await recordCompliance("shop/redact", { shop_domain: "hop.myshopify.com" });
    const fetchSpy = vi.fn<(u: RequestInfo, init?: RequestInit) => Promise<Response>>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchSpy);

    const hop = (await (await call("?chain=1")).json()) as Record<string, unknown>;
    for (const k of ["shop_redactions", "kept_alive", "uninstall_hooks", "health_workspaces"]) expect(hop).not.toHaveProperty(k);
    expect(Object.keys(await db.hgetall(globalKey.shopifyRedact()))).toEqual(["hop.myshopify.com"]);
    expect(await getConnection(gone, "shopify")).not.toBeNull();
    expect(await db.get(globalKey.connectionHealth())).toBeNull();
    // The syncs themselves still run on the hop; only the subscription pass is absent.
    expect(fetchSpy.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("webhookSubscription"))).toEqual([]);

    const first = (await (await call()).json()) as Record<string, unknown>;
    expect(first).toHaveProperty("shop_redactions");
    expect(first).toHaveProperty("health_workspaces");
    expect(await getConnection(gone, "shopify")).toBeNull();
    expect(await db.get(globalKey.connectionHealth())).not.toBeNull();
  });

  it("the syncs' start budget is what is left of 240 s since the request started; the subscription pass stops at 60 s", () => {
    const src = readFileSync("src/app/api/cron/stores/route.ts", "utf8");
    expect(src).toContain("const SYNC_START_BUDGET_MS = 240_000;");
    expect(src).toContain("const HOOKS_DEADLINE_MS = 60_000;");
    expect(src).toContain("startBudgetMs: Math.max(0, SYNC_START_BUDGET_MS - (Date.now() - now.getTime()))");
    expect(src).not.toContain("startBudgetMs: 240_000");
    for (const pass of ["applyShopRedactions(scopes)", "keepTokensAlive(scopes, now.getTime())", "backfillUninstallHooks(scopes", "tallyConnections(scopes, now, kept, hooks)"]) {
      expect(src).toContain(`once(() => ${pass}`);
    }
    expect(src.match(/maxDuration = (\d+)/)?.[1]).toBe("300");
  });
});
