import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PROVIDERS } from "@/lib/connectors/registry";
import { CALLBACK_PATH } from "@/lib/google-signin";

/**
 * docs/Registration_Packs.md opens with a "Current values" table the founder copies into each platform's portal
 * (rule 2164, docs/system/tests/2160-integrations-panel-drift.md). On 2026-10-18 the packs below it still named the
 * retired nashr-tau host, `vercel env` steps and `MS_CLIENT_ID`, which the code never reads.
 */

const doc = readFileSync("docs/Registration_Packs.md", "utf8");
const start = doc.indexOf("## Current values");
const current = doc.slice(start, doc.indexOf("Written 2026-09-27", start));
const src = (readdirSync("src", { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
  .map((f) => readFileSync(path.join("src", f), "utf8"))
  .join("\n");

describe("Registration packs current values (rule 2164)", () => {
  it("sits above the dated packs and names only thakeen.com", () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(doc.indexOf("## Shared values"));
    expect(current).not.toMatch(/nashr-tau|vercel\.app/);
  });

  it("lists every direct OAuth platform's callback and both key names, as registry.ts has them", () => {
    const direct = PROVIDERS.filter((p) => p.oauth);
    expect(direct.length).toBeGreaterThan(0);
    for (const p of direct) {
      expect(current, p.id).toContain(`\`https://thakeen.com/api/connect/${p.id}/callback\``);
      expect(current, p.id).toContain(`\`${p.oauth!.clientIdEnv}\``);
      expect(current, p.id).toContain(`\`${p.oauth!.clientSecretEnv}\``);
    }
    // No callback row for a platform that has no direct app.
    const ids = [...current.matchAll(/thakeen\.com\/api\/connect\/([a-z_]+)\/callback/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(direct.map((p) => p.id)));
  });

  it("gives Sign in with Google its own client and callback", () => {
    expect(current).toContain(`\`https://thakeen.com${CALLBACK_PATH}\``);
    for (const n of ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"]) expect(current).toContain(`\`${n}\``);
  });

  it("the names it calls unread are really unread", () => {
    for (const n of ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "TIKTOK_ADS_APP_ID", "TIKTOK_ADS_SECRET"]) {
      expect(current).toContain(`\`${n}\``);
      expect(src.includes(n), n).toBe(false);
    }
  });
});
