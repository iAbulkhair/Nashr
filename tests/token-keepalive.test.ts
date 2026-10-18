import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { keepTokensAlive, MAX_PER_RUN } from "@/lib/connectors/keepalive";
import { PROVIDERS } from "@/lib/connectors/registry";

/**
 * Rule 2179 (docs/system/tests/2160-integrations-panel-drift.md): the stores cron refreshes an expired Salla access
 * token even when nothing uses the connection, so its one-month refresh token never lapses unused.
 */

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const salla = (extra: Partial<Connection> = {}): Connection => ({ provider: "salla", data: { access_token: "old-access", refresh_token: "old-refresh" }, meta: {}, connectedAt: "2026-09-01T00:00:00Z", expiresAt: past(), ...extra });

describe("keepTokensAlive (rule 2179)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("only Salla declares a refresh-token lifetime, from its docs", () => {
    expect(PROVIDERS.filter((p) => p.oauth?.refreshTokenDays).map((p) => [p.id, p.oauth?.refreshTokenDays])).toEqual([["salla", 30]]);
  });

  it("refreshes an expired Salla token, leaves fresh, marked, Composio and other providers alone, and counts a refusal as lost", async () => {
    vi.stubEnv("SALLA_CLIENT_ID", "test-salla-id");
    vi.stubEnv("SALLA_CLIENT_SECRET", "test-salla-secret");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: URLSearchParams }) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      if (body.includes("refresh_token=refused")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires: 1209599 }), { status: 200 });
    }));
    const [due, fresh, marked, composio, refused, other] = await Promise.all(["ka-due", "ka-fresh", "ka-marked", "ka-composio", "ka-refused", "ka-other"].map((p) => newUser(p)));
    await Promise.all([
      saveConnection(due.email, salla()),
      saveConnection(fresh.email, salla({ expiresAt: future() })),
      saveConnection(marked.email, salla({ needsReconnect: past() })),
      saveConnection(composio.email, salla({ meta: { via: "composio" } })),
      saveConnection(refused.email, salla({ data: { access_token: "old-access", refresh_token: "refused" } })),
      saveConnection(other.email, { provider: "x", data: { access_token: "x-old", refresh_token: "x-refresh" }, connectedAt: "2026-09-01T00:00:00Z", expiresAt: past() }),
    ]);
    const r = await keepTokensAlive([due, fresh, marked, composio, refused, other].map((u) => u.email));
    expect(r).toEqual({ due: 2, refreshed: 1, lost: 1, failed: 0 });
    expect(bodies.sort()).toEqual([expect.stringContaining("refresh_token=old-refresh"), expect.stringContaining("refresh_token=refused")].sort());
    const kept = await getConnection(due.email, "salla");
    expect(kept?.data.refresh_token).toBe("new-refresh");
    expect(Date.parse(kept!.expiresAt!) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect((await getConnection(refused.email, "salla"))?.needsReconnect).toBeTruthy();
    expect((await getConnection(other.email, "x"))?.data.access_token).toBe("x-old");
    expect((await getConnection(fresh.email, "salla"))?.data.access_token).toBe("old-access");
  });

  it("refreshes at most MAX_PER_RUN a run, six at a time, through getFreshConnection's lock", () => {
    expect(MAX_PER_RUN).toBe(60);
    const src = readFileSync("src/lib/connectors/keepalive.ts", "utf8");
    expect(src).toContain("due.slice(0, MAX_PER_RUN)");
    expect(src).toContain("await getFreshConnection(scope, provider)");
    expect(src).toMatch(/\}, 6\);/);
    expect(src).not.toMatch(/refreshTokens\(/);
  });

  it("the stores cron runs it after the redactions and before the count and the syncs, and a failure does not stop them", () => {
    const src = readFileSync("src/app/api/cron/stores/route.ts", "utf8");
    const at = src.indexOf("keepTokensAlive(scopes, now.getTime())");
    expect(src.indexOf("applyShopRedactions(scopes)")).toBeLessThan(at);
    expect(at).toBeLessThan(src.indexOf("tallyConnections(scopes, now)"));
    expect(at).toBeLessThan(src.indexOf("runCronBatch({"));
    expect(src).toMatch(/keepTokensAlive\(scopes, now\.getTime\(\)\)\.catch\(/);
    expect(src).toContain("kept_alive: kept");
  });
});
