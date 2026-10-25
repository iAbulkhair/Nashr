import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERVIEW_COPY, OVERVIEW_RANGE, overviewOf } from "@/lib/overview";
import type { Kpis } from "@/lib/stats";
import { BRAND_SECTIONS } from "@/lib/brand-path";
import { APP_SCREENS } from "@/lib/screen-titles";
import { appDict } from "@/lib/app-i18n";

/**
 * Rule 3507: the workspace overview, an extra page beside Reports. Its numbers are `kpis` (the Reports computation) over
 * the brand's own stored tasks, drawn as server-rendered SVG; nothing estimated, an empty state with no data, no Redis
 * read in a loop, and no existing page removed or replaced.
 */
const zero: Kpis = {
  month: "30d", created: 0, createdPrev: 0, approved: 0, rejected: 0, pending: 0, approvalRate: null, autoApproved: 0, published: 0,
  images: 0, videos: 0, scheduled: 0, creditsUsed: 0, creditsUsedPrev: 0, byType: {}, byChannel: {}, weeks: [],
  daily: [{ date: "2026-10-01", created: 0, approved: 0, published: 0 }],
  window: { from: "2026-09-23", to: "2026-10-23", label: "30d" },
};
const PAGE = "src/app/[lang]/app/b/[brand]/overview/page.tsx";

describe("rule 3507: the overview numbers", () => {
  it("nothing stored and nothing waiting: the empty state, no chart data invented", () => {
    const o = overviewOf(zero, "ar");
    expect(o.empty).toBe(true);
    expect(o.types).toEqual([]);
    expect(o.tiles.every((t) => t.value === 0)).toBe(true);
    expect(o.dailyMax).toBe(1);
  });

  it("every value is a count from kpis, in order; types largest first, at most six", () => {
    const k: Kpis = {
      ...zero, created: 12, createdPrev: 6, approved: 7, published: 3, pending: 2, creditsUsed: 40, creditsUsedPrev: 0,
      byType: { social: 5, blog: 1, ad: 3, email: 0, a: 1, b: 1, c: 1, d: 1 },
      daily: [{ date: "2026-10-20", created: 4, approved: 2, published: 1 }, { date: "2026-10-21", created: 8, approved: 5, published: 2 }],
    };
    const o = overviewOf(k, "en");
    expect(o.empty).toBe(false);
    expect(o.tiles.map((t) => [t.key, t.value])).toEqual([["created", 12], ["approved", 7], ["published", 3], ["creditsUsed", 40], ["pending", 2]]);
    expect(o.tiles[0].delta).not.toBe("");
    expect(o.funnel.map((f) => f.value)).toEqual([12, 7, 3]);
    expect(o.types[0]).toEqual(["social", 5]);
    expect(o.types).toHaveLength(6);
    expect(o.types.some(([t]) => t === "email")).toBe(false);
    expect(o.dailyMax).toBe(8);
  });

  it("something waiting alone is not empty", () => {
    expect(overviewOf({ ...zero, pending: 1 }, "en").empty).toBe(false);
  });

  it("copy in Arabic and English with the same keys, and a 30-day window", () => {
    expect(Object.keys(OVERVIEW_COPY.ar).sort()).toEqual(Object.keys(OVERVIEW_COPY.en).sort());
    expect(OVERVIEW_RANGE).toBe("30");
    expect(appDict.ar.nav.overview).toBe("نظرة عامة");
    expect(appDict.en.nav.overview).toBe("Overview");
  });
});

describe("rule 3507: the page", () => {
  it("exists beside Reports, is a brand section with a screen title, and is linked from the sidebar", () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(existsSync("src/app/[lang]/app/b/[brand]/reports/page.tsx")).toBe(true);
    expect(BRAND_SECTIONS).toContain("overview");
    expect(APP_SCREENS).toContain("overview");
    const sidebar = readFileSync("src/components/app/Sidebar.tsx", "utf8");
    expect(sidebar).toContain('row(to("/overview"), N.overview');
    expect(sidebar).toContain('row(to("/reports")');
  });

  it("reads through the caller's scope once, never in a loop, and draws SVG with an empty state and a table", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("listLite(sc(u), kpiSince(win))");
    expect(src).toContain("kpis(sc(u), undefined, win, tasks)");
    expect(src).not.toMatch(/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/);
    expect(src).not.toMatch(/for \([^)]*\)[^{]*\{[^}]*await/);
    expect(src).toContain("<svg");
    expect(src).toContain("<EmptyState");
    expect(src).toContain("<table");
    expect(src).toContain('href("/reports")');
    // No number typed into the page: every value comes from `o`.
    expect(src).not.toMatch(/>\s*\d{2,}\s*</);
  });
});
