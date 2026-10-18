import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { INTEGRATIONS, halfSetComposio, integrationNames, integrationsView } from "@/lib/integration-status";
import { PROVIDERS } from "@/lib/connectors/registry";
import { CALLBACK_PATH } from "@/lib/google-signin";

/**
 * The console's Integrations page must match what the code reads today (rules 2160-2162 and 2165, docs/system/tests/2160-integrations-panel-drift.md).
 * On 2026-10-18 it still asked kie.ai and Higgsfield for `BLOB_READ_WRITE_TOKEN`, which nothing has read since the disk
 * store (rules 1750-1763), and it had no row for Google sign-in (#376).
 */

const SRC = "src";
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
  .map((f) => path.join(SRC, f))
  .filter((f) => f !== path.join("src", "lib", "integration-status.ts"));
const code = files.map((f) => readFileSync(f, "utf8")).join("\n");

const row = (id: string) => {
  const r = INTEGRATIONS.find((i) => i.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const status = (id: string, env: Record<string, string>) => integrationsView(env, false).find((i) => i.id === id)?.status;

describe("Integrations page drift (rules 2160-2162)", () => {
  it("kie.ai and Higgsfield need the disk store, as media/config.ts does, not the retired Blob token (rule 2160)", () => {
    expect(integrationNames()).not.toContain("BLOB_READ_WRITE_TOKEN");
    expect(row("kie").need).toEqual({ all: ["KIE_API_KEY", "MEDIA_DIR"] });
    expect(row("higgsfield").need).toEqual({ all: ["HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET", "MEDIA_DIR"] });
    expect(status("kie", { KIE_API_KEY: "x", MEDIA_DIR: "/m" })).toBe("on");
    expect(status("kie", { KIE_API_KEY: "x" })).toBe("partial");
    expect(status("higgsfield", { HIGGSFIELD_API_KEY_ID: "x", HIGGSFIELD_API_KEY_SECRET: "y", MEDIA_DIR: "/m" })).toBe("on");
    // The rule the panel mirrors: a kie or Higgsfield model is offered only with the store configured; fal needs none.
    expect(readFileSync("src/lib/media/config.ts", "utf8")).toContain('(p === "fal" || storeConfigured())');
  });

  it("Sign in with Google has its own row, from the two names google-signin.ts reads (rule 2161)", () => {
    expect(row("google_signin").need).toEqual({ all: ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"] });
    const g = readFileSync("src/lib/google-signin.ts", "utf8");
    for (const n of ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"]) expect(g).toContain(`process.env.${n}`);
    expect(status("google_signin", { GOOGLE_SIGNIN_CLIENT_ID: "x", GOOGLE_SIGNIN_CLIENT_SECRET: "y" })).toBe("on");
    expect(status("google_signin", { GOOGLE_SIGNIN_CLIENT_ID: "x" })).toBe("partial");
    // The calendar's Google client is a different app: its names never turn sign-in on.
    expect(status("google_signin", { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" })).toBe("off");
  });

  it("every name the page shows is still read somewhere in src/ outside the page's own list (rule 2162)", () => {
    for (const n of integrationNames()) expect(code.includes(n), n).toBe(true);
  });

  it("a two-toolkit Composio provider with one auth name set and the other missing is flagged, by name only (rule 2165)", () => {
    const has = (set: string[]) => (n: string) => set.includes(n);
    expect(halfSetComposio(has([]))).toEqual([]);
    expect(halfSetComposio(has(["COMPOSIO_AUTH_GOOGLEDOCS", "COMPOSIO_AUTH_GOOGLESHEETS", "COMPOSIO_AUTH_LINKEDIN"]))).toEqual([]);
    const half = halfSetComposio(has(["COMPOSIO_AUTH_GOOGLEDOCS", "COMPOSIO_AUTH_FACEBOOK"]));
    expect(half.map((g) => g.id).sort()).toEqual(["composio_half_google_workspace", "composio_half_meta"]);
    expect(half.every((g) => g.off)).toBe(true);
    expect(half.find((g) => g.id === "composio_half_meta")?.label.en).toContain("COMPOSIO_AUTH_INSTAGRAM is missing");
    // On the page: under the Composio row only, and the same for any value (rule 1542 still holds).
    const gates = (v: string) => integrationsView({ COMPOSIO_API_KEY: v, COMPOSIO_PROVIDERS: v, COMPOSIO_AUTH_GOOGLEDOCS: v }, false).flatMap((i) => i.gates.map((g) => `${i.id}:${g.id}`));
    expect(gates("x")).toContain("composio:composio_half_google_workspace");
    expect(gates("SENTINEL-other")).toEqual(gates("x"));
  });

  it("each direct-app row shows the callback paths its platform app must list (rule 2165)", () => {
    const view = integrationsView({}, false);
    const cb = (id: string) => view.find((i) => i.id === id)?.callbacks;
    expect(cb("meta")).toEqual(["/api/connect/meta/callback", "/api/connect/meta_ads/callback"]);
    expect(cb("gcal")).toEqual(["/api/connect/google/callback", "/api/connect/gcal/callback"]);
    expect(cb("google_signin")).toEqual([CALLBACK_PATH]);
    expect(cb("composio")).toEqual([]);
    // Every direct OAuth provider's callback appears on exactly one row.
    const all = view.flatMap((i) => i.callbacks);
    expect(new Set(all).size).toBe(all.length);
    for (const p of PROVIDERS) if (p.oauth) expect(all).toContain(`/api/connect/${p.id}/callback`);
    expect(readFileSync("src/components/admin/IntegrationsPanel.tsx", "utf8")).toContain("i.callbacks.map(");
  });
});
