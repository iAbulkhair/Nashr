import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminSignIn, json, newUser, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { connectionHealth, tallyConnections } from "@/lib/connectors/health";
import * as integrationsRoute from "@/app/api/admin/integrations/route";

/**
 * Rules 2177-2178 (docs/system/tests/2160-integrations-panel-drift.md): the stores cron counts every workspace's
 * connections per platform under one fixed key, and the founder console's Integrations page shows the counts, with the
 * same run's token keep-alive (rule 2202) and Shopify uninstall-webhook (rule 2205) counts.
 */

const conn = (provider: string, extra: Partial<Connection> = {}): Connection => ({ provider, data: { access_token: "test-token" }, meta: {}, connectedAt: "2026-10-01T00:00:00Z", ...extra });

async function threeWorkspaces() {
  const [a, b, c] = await Promise.all([newUser("health-a"), newUser("health-b"), newUser("health-c")]);
  await Promise.all([
    saveConnection(a.email, conn("shopify", { meta: { shop: "a.myshopify.com", account: "Store A" } })),
    saveConnection(a.email, conn("x", { needsReconnect: "refused" })),
    saveConnection(b.email, conn("shopify", { needsReconnect: "refused" })),
    saveConnection(b.email, conn("linkedin", { meta: { via: "composio" } })),
    saveConnection(c.email, conn("not-a-platform")),
  ]);
  return [a.email, b.email, c.email];
}

describe("tallyConnections (rule 2177)", () => {
  it("counts connected, must-reconnect and Composio per platform, keeps only counts, and skips unknown ids", async () => {
    const scopes = await threeWorkspaces();
    const h = await tallyConnections(scopes, new Date("2026-10-18T02:00:00Z"));
    expect(h).toEqual({
      at: "2026-10-18T02:00:00.000Z",
      workspaces: 3,
      providers: {
        shopify: { connected: 2, reconnect: 1, composio: 0 },
        x: { connected: 1, reconnect: 1, composio: 0 },
        linkedin: { connected: 1, reconnect: 0, composio: 1 },
      },
    });
    const stored = JSON.stringify(await db.get(globalKey.connectionHealth()));
    for (const s of [...scopes, "a.myshopify.com", "Store A", "test-token", "not-a-platform"]) expect(stored).not.toContain(s);
    expect(await connectionHealth()).toEqual(h);
  });

  it("reads null before the first run, zeros for a broken count, and leaves out an id the registry does not know", async () => {
    await db.del(globalKey.connectionHealth());
    expect(await connectionHealth()).toBeNull();
    await db.set(globalKey.connectionHealth(), { at: "2026-10-18T02:00:00Z", workspaces: "many", providers: { x: { connected: -1, reconnect: 1.5, composio: "2" }, evil: { connected: 9 } } });
    expect(await connectionHealth()).toEqual({ at: "2026-10-18T02:00:00Z", workspaces: 0, providers: { x: { connected: 0, reconnect: 0, composio: 0 } } });
    await db.set(globalKey.connectionHealth(), { workspaces: 1 });
    expect(await connectionHealth()).toBeNull();
  });

  it("keeps the same run's keep-alive counts beside them, null when the pass failed, zeros for broken ones (rule 2202)", async () => {
    const scopes = await threeWorkspaces();
    const kept = { due: 3, refreshed: 2, lost: 1, failed: 0 };
    expect((await tallyConnections(scopes, new Date(), kept)).keepAlive).toEqual(kept);
    expect((await connectionHealth())?.keepAlive).toEqual(kept);
    await tallyConnections(scopes, new Date(), null);
    expect((await connectionHealth())?.keepAlive).toBeNull();
    await db.set(globalKey.connectionHealth(), { at: "2026-10-18T02:00:00Z", workspaces: 1, providers: {}, keepAlive: { due: "x", refreshed: -2, lost: 1 } });
    expect((await connectionHealth())?.keepAlive).toEqual({ due: 0, refreshed: 0, lost: 1, failed: 0 });
    await tallyConnections(scopes);
    expect(await connectionHealth()).not.toHaveProperty("keepAlive");
  });

  it("keeps the same run's Shopify uninstall-webhook counts too, null when the pass failed, zeros for broken ones (rule 2205)", async () => {
    const scopes = await threeWorkspaces();
    const kept = { due: 0, refreshed: 0, lost: 0, failed: 0 };
    const hooks = { due: 4, subscribed: 3, failed: 1 };
    expect((await tallyConnections(scopes, new Date(), kept, hooks)).uninstallHooks).toEqual(hooks);
    expect(await connectionHealth()).toMatchObject({ keepAlive: kept, uninstallHooks: hooks });
    await tallyConnections(scopes, new Date(), kept, null);
    expect((await connectionHealth())?.uninstallHooks).toBeNull();
    await db.set(globalKey.connectionHealth(), { at: "2026-10-18T02:00:00Z", workspaces: 1, providers: {}, uninstallHooks: { due: "x", subscribed: -1, failed: 2 } });
    expect((await connectionHealth())?.uninstallHooks).toEqual({ due: 0, subscribed: 0, failed: 2 });
    await tallyConnections(scopes, new Date(), kept);
    expect(await connectionHealth()).not.toHaveProperty("uninstallHooks");
  });

  it("reads each workspace through pmap and writes one fixed key", () => {
    const src = readFileSync("src/lib/connectors/health.ts", "utf8");
    expect(src).toContain("pmap(scopes, (scope) => listConnections(scope))");
    expect(src).not.toMatch(/for \([^)]*\) \{?\s*await/);
    expect(src.match(/db\.\w+[<(]/g)).toEqual(["db.set(", "db.get<"]);
    expect(src).toContain("db.set(globalKey.connectionHealth(), health)");
  });

  it("the stores cron counts after the redactions and before the syncs, and a failed count does not stop them", () => {
    const src = readFileSync("src/app/api/cron/stores/route.ts", "utf8");
    expect(src.indexOf("applyShopRedactions(scopes)")).toBeGreaterThan(0);
    expect(src.indexOf("applyShopRedactions(scopes)")).toBeLessThan(src.indexOf("tallyConnections(scopes, now, kept, hooks)"));
    expect(src.indexOf("tallyConnections(scopes, now, kept, hooks)")).toBeLessThan(src.indexOf("runCronBatch({"));
    expect(src).toMatch(/tallyConnections\(scopes, now, kept, hooks\)[\s\S]{0,120}\.catch\(/);
    expect(src).toContain("health_workspaces: health");
  });
});

describe("the Integrations page shows the counts to a founder (rule 2178)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("GET /api/admin/integrations: 401 first, then the rows busiest first with the registry's names, null when the read fails", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-connection-health");
    const scopes = await threeWorkspaces();
    await tallyConnections(scopes);
    expect((await integrationsRoute.GET(json("/api/admin/integrations", "GET"))).status).toBe(401);
    await adminSignIn();
    try {
      const res = await integrationsRoute.GET(json("/api/admin/integrations", "GET"));
      const text = await res.text();
      for (const s of scopes) expect(text).not.toContain(s);
      const body = JSON.parse(text) as { connections: { workspaces: number; rows: { id: string; name: string; connected: number; reconnect: number }[] } };
      expect(body.connections.workspaces).toBe(3);
      expect(body.connections.rows.map((r) => r.id)).toEqual(["shopify", "linkedin", "x"]);
      expect(body.connections.rows[0]).toMatchObject({ name: "Shopify", connected: 2, reconnect: 1 });
      expect(body.connections).toHaveProperty("keepAlive", null);
      expect(body.connections).toHaveProperty("uninstallHooks", null);

      const get = db.get.bind(db);
      vi.spyOn(db, "get").mockImplementation(((key: string) => (key === globalKey.connectionHealth() ? Promise.reject(new Error("down")) : get(key))) as typeof db.get);
      const down = await integrationsRoute.GET(json("/api/admin/integrations", "GET"));
      expect(down.status).toBe(200);
      expect((await down.json()) as object).toMatchObject({ ok: true, connections: null });
    } finally {
      signOut();
    }
    const r = readFileSync("src/app/api/admin/integrations/route.ts", "utf8");
    expect(r.indexOf("adminActor(req)")).toBeLessThan(r.indexOf("connectionHealth()"));
  });

  it("the panel renders the table with a warning badge for platforms that must reconnect", () => {
    const src = readFileSync("src/components/admin/IntegrationsPanel.tsx", "utf8");
    expect(src).toContain('data-testid="integrations-connections"');
    expect(src).toContain("setConnections(j.connections ?? null)");
    expect(src).toContain('r.reconnect > 0 ? <Badge tone="warning">');
    expect(src).toContain('data-testid="integrations-keepalive"');
    expect(src).toMatch(/keepAlive\.lost \+ connections\.keepAlive\.failed > 0 && <Badge tone="warning"/);
    // Rule 2205: the uninstall-webhook line, a warning badge when a subscription failed, and the uninstall receipt's label.
    expect(src).toContain('data-testid="integrations-uninstall-hooks"');
    expect(src).toContain('connections.uninstallHooks.failed > 0 && <Badge tone="warning"');
    expect(src.match(/"app\/uninstalled": "/g)).toHaveLength(2);
  });
});
