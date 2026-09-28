import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { IMPORTS_PRODUCTS, READS_METRICS, WORKING_PROVIDERS, isWorking } from "@/lib/connectors/working";
import { ORDER_READERS } from "@/lib/connectors/orders";
import { costUsd } from "@/lib/usage";

// Rule 65: the app calls a connection "Connected", offers "Connect", or reads numbers from it only when code uses it.
describe("which connectors do something", () => {
  const publish = readFileSync("src/lib/connectors/publish.ts", "utf8");
  const connect = readFileSync("src/app/api/connect/[provider]/route.ts", "utf8");
  const publishers = [...publish.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
  const importLine = connect.split("\n").find((l) => l.includes("await importShopify(")) ?? "";
  const importers = [...importLine.matchAll(/provider === "([a-z]+)"/g)].map((m) => m[1]);

  it("lists exactly the providers that publish.ts publishes to and import_products imports from", () => {
    expect(publishers.length).toBeGreaterThan(0);
    expect(importers.length).toBeGreaterThan(0);
    expect([...WORKING_PROVIDERS].sort()).toEqual([...new Set([...publishers, ...importers])].sort());
  });

  it("does not treat a stored connection with no code behind it as working", () => {
    for (const id of ["klaviyo", "brevo", "google", "meta", "instagram", "whatsapp", "tiktok", "snapchat", "linkedin"]) expect(isWorking(id)).toBe(false);
  });

  it("offers Import products exactly where import_products imports", () => {
    expect([...IMPORTS_PRODUCTS].sort()).toEqual([...importers].sort());
  });

  it("reads platform numbers only from providers with an order reader", () => {
    const orders = readFileSync("src/lib/connectors/orders.ts", "utf8");
    const reader = orders.slice(orders.indexOf("export async function readOrders"));
    const cases = [...reader.slice(0, reader.indexOf("default:")).matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect([...READS_METRICS].sort()).toEqual([...ORDER_READERS].sort());
    expect([...READS_METRICS].sort()).toEqual(cases.sort());
    // Store numbers come from store-metrics.ts; the workspace KPIs never read a connection.
    expect(readFileSync("src/lib/stats.ts", "utf8")).not.toMatch(/getConnection|listConnections/);
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
