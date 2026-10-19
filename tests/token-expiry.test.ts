import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { tokenExpiry } from "@/lib/connectors/oauth";
import { getConnection, saveConnection } from "@/lib/connectors/store";
import { getFreshConnection } from "@/lib/connectors/fresh";

/**
 * Rule 2176 (docs/system/tests/2160-integrations-panel-drift.md): a token answer's expiry is read from `expires_in`, or
 * from Salla's `expires` (a Unix time or a lifetime in seconds), at connect and at every refresh.
 */

const NOW = Date.parse("2026-10-18T12:00:00Z");

describe("tokenExpiry (rule 2176)", () => {
  it("reads expires_in as seconds from now", () => {
    expect(tokenExpiry({ expires_in: "3600" }, NOW)).toBe("2026-10-18T13:00:00.000Z");
  });

  it("reads Salla's expires as a lifetime when it is small, and as a Unix time when it is large", () => {
    expect(tokenExpiry({ expires: "1209599" }, NOW)).toBe(new Date(NOW + 1209599 * 1000).toISOString());
    const at = Math.floor(Date.parse("2026-11-01T12:00:00Z") / 1000);
    expect(tokenExpiry({ expires: String(at) }, NOW)).toBe("2026-11-01T12:00:00.000Z");
  });

  it("prefers expires_in, and answers undefined when neither says (Shopify's offline token)", () => {
    expect(tokenExpiry({ expires_in: "60", expires: "1209599" }, NOW)).toBe("2026-10-18T12:01:00.000Z");
    expect(tokenExpiry({}, NOW)).toBeUndefined();
    expect(tokenExpiry({ expires_in: "soon", expires: "-1" }, NOW)).toBeUndefined();
    expect(tokenExpiry({ expires_in: "0" }, NOW)).toBeUndefined();
  });

  it("is the only expiry reading at connect and at refresh", () => {
    for (const f of ["src/app/api/connect/[provider]/callback/route.ts", "src/lib/connectors/fresh.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("tokenExpiry(data)");
      expect(src, f).not.toMatch(/data\.expires_in/);
    }
  });
});

describe("a Salla refresh that answers `expires` keeps an expiry, so the next one comes early (rule 2176)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stores the new tokens and an expiry about 14 days out", async () => {
    vi.stubEnv("SALLA_CLIENT_ID", "test-salla-id");
    vi.stubEnv("SALLA_CLIENT_SECRET", "test-salla-secret");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: URLSearchParams }) => {
      calls.push(`${url} ${String(init?.body ?? "")}`);
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires: 1209599, token_type: "bearer" }), { status: 200 });
    }));
    const u = await newUser("salla-expiry");
    await saveConnection(u.email, { provider: "salla", data: { access_token: "old-access", refresh_token: "old-refresh" }, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const c = await getFreshConnection(u.email, "salla");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://accounts.salla.sa/oauth2/token");
    expect(calls[0]).toContain("refresh_token=old-refresh");
    expect(c?.data.access_token).toBe("new-access");
    const stored = await getConnection(u.email, "salla");
    expect(stored?.data.refresh_token).toBe("new-refresh");
    const left = new Date(stored!.expiresAt!).getTime() - Date.now();
    expect(left).toBeGreaterThan(13 * 86_400_000);
    expect(left).toBeLessThan(15 * 86_400_000);
  });
});
