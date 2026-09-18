import { describe, expect, it } from "vitest";
import { PARTS, buildFromSite } from "@/lib/onboard";
import type { SiteSnapshot } from "@/lib/crawl";

const KEYS = ["brand", "brand_md", "brand_guidelines_md", "opportunities_md", "market_research_md", "strategy_md", "plan", "goal", "summary"];

describe("onboarding is split into parallel parts", () => {
  it("every output key is asked for by exactly one part", () => {
    const asked = Object.values(PARTS).flatMap((p) => Object.keys(p.schema.properties));
    expect([...asked].sort()).toEqual([...KEYS].sort());
    expect(new Set(asked).size).toBe(asked.length);
  });
  it("each part requires all of its own keys and allows nothing else", () => {
    for (const p of Object.values(PARTS)) {
      expect([...p.schema.required].sort()).toEqual(Object.keys(p.schema.properties).sort());
      expect(p.schema.additionalProperties).toBe(false);
    }
  });
  it("still returns the five workspace files and a three-task plan (mock path, no model)", async () => {
    const site = { url: "https://roastery.example", ok: true, title: "Roastery | Home", description: "Coffee", text: "", links: [], platform: "unknown", colors: [], fonts: [] } as unknown as SiteSnapshot;
    const r = await buildFromSite(site, "ar");
    expect(r.files.map((f) => f.name)).toEqual(["brand.md", "brand-guidelines.md", "opportunities.md", "market-research.md", "strategy.md"]);
    expect(r.plan).toHaveLength(3);
  });
});
