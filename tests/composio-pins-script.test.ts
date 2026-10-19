import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkPins, schemaDrift, type FetchSchema } from "../scripts/check-composio-pins";
import { TOOLKITS } from "@/lib/connectors/composio-catalog";
import { TOOLKIT_VERSION } from "@/lib/connectors/composio";

/** scripts/check-composio-pins.ts reads each allowlisted tool at its PINNED version (rule 2166, docs/system/tests/2160-integrations-panel-drift.md). */

const KEY = { COMPOSIO_API_KEY: "SENTINEL-key" };
/** A schema that holds exactly what the catalog sends for the tool. */
const exact: FetchSchema = async (slug) => {
  for (const e of Object.values(TOOLKITS)) {
    const args = { ...e.read, ...e.write }[slug];
    if (args) return { properties: Object.fromEntries(args.map((a) => [a, {}])), required: [] };
  }
  return null;
};

describe("check-composio-pins (rule 2166)", () => {
  it("schemaDrift names allowlisted args the schema lacks and required args that are neither sent nor fixed", () => {
    expect(schemaDrift({ properties: { a: {}, b: {} }, required: ["a"] }, ["a", "b"])).toEqual({ missing: [], requiredNotSent: [] });
    expect(schemaDrift({ properties: { a: {} }, required: ["a", "z", "y"] }, ["a", "b"], { y: 1 })).toEqual({ missing: ["b"], requiredNotSent: ["z"] });
    expect(schemaDrift({}, [])).toEqual({ missing: [], requiredNotSent: [] });
  });

  it("asks for every tool at its toolkit's pinned version, and passes when each schema holds", async () => {
    const asked: string[] = [];
    const r = await checkPins(KEY, async (slug, v) => { asked.push(`${slug}@${v}`); return exact(slug, v); });
    expect(r.code).toBe(0);
    const want = Object.entries(TOOLKITS).flatMap(([t, e]) => Object.keys({ ...e.read, ...e.write }).map((s) => `${s}@${TOOLKIT_VERSION[t as keyof typeof TOOLKIT_VERSION]}`));
    expect(asked).toEqual(want);
  });

  it("exit 1 for a tool missing at the pin or drifted, naming toolkit, pin and slug", async () => {
    const gone = Object.keys({ ...TOOLKITS.instagram.read, ...TOOLKITS.instagram.write })[0];
    const drifted = Object.keys({ ...TOOLKITS.linkedin.read, ...TOOLKITS.linkedin.write })[0];
    const r = await checkPins(KEY, async (slug, v) => (slug === gone ? null : slug === drifted ? { properties: {}, required: ["zz_new"] } : exact(slug, v)), ["instagram", "linkedin"]);
    expect(r.code).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain(`MISSING instagram@${TOOLKIT_VERSION.instagram} ${gone}:`);
    expect(text).toContain(`DRIFT linkedin@${TOOLKIT_VERSION.linkedin} ${drifted}:`);
    expect(text).toContain("required but never sent: zz_new");
    expect(text).toContain("2 of ");
  });

  it("exit 2 without a key, for an unknown toolkit, or when a request fails; the key and error texts are never printed", async () => {
    expect((await checkPins({}, exact)).code).toBe(2);
    expect((await checkPins(KEY, exact, ["nosuch"])).code).toBe(2);
    const r = await checkPins(KEY, async () => { throw new TypeError("SENTINEL-body fetch failed"); }, ["facebook"]);
    expect(r.code).toBe(2);
    expect(r.lines.join("\n")).toContain("(TypeError)");
    expect(r.lines.join("\n")).not.toContain("SENTINEL");
    expect((await checkPins(KEY, exact)).lines.join("\n")).not.toContain("SENTINEL");
  });

  it("builds the SDK only after the key check, with the project key and no tracking", () => {
    const s = readFileSync("scripts/check-composio-pins.ts", "utf8");
    expect(s).toContain("new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false })");
    expect(s.indexOf("new Composio(")).toBeGreaterThan(s.indexOf("if (!sdk)"));
    expect(s).toContain("getRawComposioToolBySlug(slug, { version })");
  });
});
