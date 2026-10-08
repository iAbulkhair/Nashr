import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { IMPORTS_PRODUCTS, READS_ADS, READS_METRICS, WORKING_PROVIDERS, isWorking } from "@/lib/connectors/working";
import { AD_PROVIDERS } from "@/lib/connectors/ads";
import { SALES_PROVIDERS } from "@/lib/connectors/sales";
import { reportSources } from "@/lib/report-sources";
import { costUsd } from "@/lib/usage";

// Rule 65: the app calls a connection "Connected", offers "Connect", or reads numbers from it only when code uses it.
describe("which connectors do something", () => {
  const publish = readFileSync("src/lib/connectors/publish.ts", "utf8");
  const connect = readFileSync("src/app/api/connect/[provider]/route.ts", "utf8");
  // Facebook and Instagram are publish targets of one "meta" connection (targets.ts CONNECTION_OF).
  const publishers = [...publish.matchAll(/case "([a-z]+)":/g)].map((m) => ({ facebook: "meta", instagram: "meta" } as Record<string, string>)[m[1]] ?? m[1]);
  const importLine = connect.split("\n").find((l) => l.includes("await importShopify(")) ?? "";
  const importers = [...importLine.matchAll(/provider === "([a-z]+)"/g)].map((m) => m[1]);

  it("lists exactly the providers that publish.ts publishes to and import_products imports from", () => {
    expect(publishers.length).toBeGreaterThan(0);
    expect(importers.length).toBeGreaterThan(0);
    expect([...WORKING_PROVIDERS].sort()).toEqual([...new Set([...publishers, ...importers])].sort());
  });

  it("does not treat a stored connection with no code behind it as working", () => {
    // LinkedIn and TikTok work through Composio only (rule 650 keeps a direct record of them from being a target). Klaviyo,
    // Brevo, WhatsApp and YouTube work as drafts since rule 658 (publish.ts has their cases).
    for (const id of ["google", "instagram", "snapchat", "unifonic", "mailchimp"]) expect(isWorking(id)).toBe(false);
  });

  it("offers Import products exactly where import_products imports", () => {
    expect([...IMPORTS_PRODUCTS].sort()).toEqual([...importers].sort());
  });

  it("reads platform numbers only from the stores the sales sync reads and the ad accounts syncAds reads, and stats.ts reads no connection", () => {
    expect([...READS_ADS].sort()).toEqual([...AD_PROVIDERS].sort());
    // Google is read only for the site block (src/lib/site-stats.ts), Meta only for Instagram results
    // (src/lib/social-stats.ts), and both only through Composio.
    expect([...READS_METRICS].sort()).toEqual([...SALES_PROVIDERS, ...AD_PROVIDERS, "google", "meta"].sort());
    expect(reportSources(["meta_ads"]).read).toEqual(["ads"]);
    // The Page connection reads no ad numbers; through Composio it reads Instagram results.
    expect(reportSources(["meta"]).read).toEqual(["social"]);
    expect(readFileSync("src/lib/stats.ts", "utf8")).not.toMatch(/getConnection|listConnections/);
  });

  it("tells Reports which sources are read: a store with a sales reader silences the store warning, a stored connection without one does not", () => {
    expect(reportSources([])).toEqual({ read: [], missing: ["analytics", "ads", "store", "social"], banner: "none" });
    expect(reportSources(["salla"])).toEqual({ read: ["store"], missing: ["analytics", "ads", "social"], banner: "some" });
    expect(reportSources(["shopify", "x"]).read).toEqual(["store"]);
    expect(reportSources(["zid"]).read).toEqual(["store"]);
    expect(reportSources(["woocommerce"]).read).toEqual(["store"]);
    // The Meta Page connection publishes; it reads no numbers.
    expect(reportSources(["meta"])).toMatchObject({ read: ["social"], banner: "some" });
    // Google is the site connection: analytics only, never ads. The reports page drops a direct (non-Composio) Google or
    // Meta record: neither has a reader behind it.
    expect(reportSources(["google"]).read).toEqual(["analytics"]);
    // Snapchat is Snapchat Ads: ad results, not a social account.
    expect(reportSources(["snapchat"]).read).toEqual(["ads"]);
    expect(reportSources(["tiktok_ads"]).read).toEqual(["ads"]);
    expect(reportSources(["google_ads"]).read).toEqual(["ads"]);
    expect(readFileSync("src/app/[lang]/app/reports/page.tsx", "utf8")).toMatch(/!READ_VIA_COMPOSIO\.includes\(c\.provider\) \|\| isComposio\(c\)/);
    expect(readFileSync("src/app/[lang]/app/reports/page.tsx", "utf8")).toMatch(/READ_VIA_COMPOSIO = \["google", "meta"\]/);
  });
});

// Rule 66: model costs in the founder console use Anthropic's list prices.
describe("model list prices", () => {
  it("prices Sonnet 5 at $2 in and $10 out per million tokens, and Opus 5 at $5 and $25", () => {
    expect(costUsd("claude-sonnet-5", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(12);
    expect(costUsd("claude-sonnet-5", { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 })).toBeCloseTo(2.7);
    expect(costUsd("claude-opus-5", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(30);
  });
});
