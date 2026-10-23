import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { areaPath, barRects, clamp, linePath, percent, scalePoints, xAt, yAt } from "@/lib/chart-math";
import Progress from "@/components/ui/Progress";
import { BarChart, LineChart, Sparkline } from "@/components/ui/Chart";

// Rules 3130-3136: one Progress bar, in-house SVG charts, a sparkline in the reports tiles. The pure maths and the rendered
// markup are tested directly; the three call sites and the missing dependency are source scans (like ui-review-2970.test.ts).
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("chart maths (rules 3131, 3132)", () => {
  it("3131: percent and clamp stay inside range and survive bad input", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(-3, 10)).toBe(0);
    expect(percent(3, 0)).toBe(0);
    expect(percent(3, Number.NaN)).toBe(0);
    expect(clamp(Number.NaN, 0, 5)).toBe(0);
    expect(yAt(10, 10, 100, 10)).toBe(10);
    expect(yAt(0, 10, 100, 10)).toBe(90);
    expect(yAt(5, 0, 100, 10)).toBe(90);
  });

  it("3131: points scale into the box, the largest value at the top, and a path is built from them", () => {
    const pts = scalePoints([0, 5, 10], 100, 50, { pad: 0 });
    expect(pts).toEqual([{ x: 0, y: 50 }, { x: 50, y: 25 }, { x: 100, y: 0 }]);
    expect(linePath(pts)).toBe("M0,50 L50,25 L100,0");
    expect(areaPath(pts, 50)).toBe("M0,50 L50,25 L100,0 L100,50 L0,50 Z");
    expect(linePath([])).toBe("");
    expect(areaPath([], 50)).toBe("");
    expect(scalePoints([4], 100, 50)[0].x).toBe(50);
    expect(scalePoints([0, 0], 100, 50).every((p) => p.y === 50)).toBe(true);
  });

  it("3132: in RTL the oldest point is at the right edge and the newest at the left", () => {
    expect(xAt(0, 5, 100, 10, false)).toBe(10);
    expect(xAt(4, 5, 100, 10, false)).toBe(90);
    expect(xAt(0, 5, 100, 10, true)).toBe(90);
    expect(xAt(4, 5, 100, 10, true)).toBe(10);
    const ltr = scalePoints([1, 2, 3], 100, 50, { rtl: false });
    const rtl = scalePoints([1, 2, 3], 100, 50, { rtl: true });
    expect(rtl.map((p) => p.x)).toEqual([...ltr.map((p) => p.x)].reverse());
    expect(rtl.map((p) => p.y)).toEqual(ltr.map((p) => p.y));
  });

  it("3132: bars mirror too, and never leave the plot", () => {
    const l = barRects([1, 2, 3], 120, 60, { pad: 0, gap: 0, rtl: false });
    const r = barRects([1, 2, 3], 120, 60, { pad: 0, gap: 0, rtl: true });
    expect(l.map((b) => b.x)).toEqual([0, 40, 80]);
    expect(r.map((b) => b.x)).toEqual([80, 40, 0]);
    expect(l[2].h).toBe(60);
    expect(barRects([], 100, 50)).toEqual([]);
    for (const b of r) expect(b.x + b.w).toBeLessThanOrEqual(120);
  });
});

describe("Progress (rules 3130, 3136)", () => {
  it("3130: renders a named progressbar with min, max and now", () => {
    const out = html(createElement(Progress, { value: 3, max: 5, label: "Seats", valueText: "3 / 5" }));
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="5"');
    expect(out).toContain('aria-valuenow="3"');
    expect(out).toContain('aria-label="Seats"');
    expect(out).toContain('aria-valuetext="3 / 5"');
    expect(out).toContain("width:60%");
  });

  it("3136: a value above the limit or a zero limit never reports an impossible state", () => {
    const over = html(createElement(Progress, { value: 9, max: 5, label: "x" }));
    expect(over).toContain('aria-valuenow="5"');
    expect(over).toContain("width:100%");
    const none = html(createElement(Progress, { value: 2, max: 0, label: "x" }));
    expect(none).toContain('aria-valuenow="0"');
    expect(none).toContain("width:0%");
  });

  it("3130: warn tone and the journey variant keep their old look", () => {
    expect(html(createElement(Progress, { value: 5, max: 5, label: "x", tone: "warn" }))).toContain("bg-lemon");
    const j = html(createElement(Progress, { value: 0, max: 8, label: "x", variant: "journey", minFill: 4 }));
    expect(j).toContain("journey-track");
    expect(j).toContain("journey-fill");
    expect(j).toContain("--p:0.04");
  });

  it("3130: the three inline bars are gone and use Progress", () => {
    for (const f of ["ChatAllowanceCard", "TeamPanel", "JourneyCard"]) {
      const s = src(`src/components/app/${f}.tsx`);
      expect(s, f).toContain('from "@/components/ui/Progress"');
      expect(s, f).not.toContain('role="progressbar"');
    }
  });
});

describe("Charts (rules 3131, 3133)", () => {
  const data = [{ label: "Mon", value: 1 }, { label: "Tue", value: 4 }, { label: "Wed", value: 2 }];
  const common = { data, caption: "Posts per day", labelHeader: "Day", valueHeader: "Posts" };

  it("3133: bars and line hide the drawing and carry every number in a visually hidden table", () => {
    for (const el of [createElement(BarChart, common), createElement(LineChart, common)]) {
      const out = html(el);
      expect(out).toContain('aria-hidden="true"');
      expect(out).toContain('class="sr-only"');
      expect(out).toContain("<caption>Posts per day</caption>");
      for (const d of data) expect(out).toContain(`<th scope="row">${d.label}</th><td>${d.value}</td>`);
    }
  });

  it("3132: the RTL chart lists the same rows but draws the first bar at the right", () => {
    const ltr = html(createElement(BarChart, common));
    const rtl = html(createElement(BarChart, { ...common, dir: "rtl" }));
    const firstX = (s: string) => Number(/<rect x="([\d.]+)"/.exec(s)![1]);
    expect(firstX(rtl)).toBeGreaterThan(firstX(ltr));
    expect(rtl).toContain('dir="rtl"');
  });

  it("3133: an empty series draws nothing, and the formatter is used in the table", () => {
    expect(html(createElement(BarChart, { ...common, data: [] }))).toBe("");
    expect(html(createElement(LineChart, { ...common, data: [] }))).toBe("");
    expect(html(createElement(LineChart, { ...common, format: (v: number) => `${v}%` }))).toContain("<td>4%</td>");
  });

  it("3133: the line chart uses a chart token, not a hard-coded colour", () => {
    expect(html(createElement(LineChart, common))).toContain("var(--chart-1)");
    const s = src("src/components/ui/Chart.tsx");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("3134: a sparkline needs two points, hides the drawing and speaks its summary", () => {
    expect(html(createElement(Sparkline, { values: [3], summary: "x" }))).toBe("");
    const out = html(createElement(Sparkline, { values: [1, 3, 2], summary: "Created: 1, 3, 2" }));
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('<span class="sr-only">Created: 1, 3, 2</span>');
  });
});

describe("Reports tiles and dependencies (rules 3134, 3135)", () => {
  it("3134: the reports tiles draw a sparkline from the series the page already loads (k.daily), in the page's direction", () => {
    const s = src("src/components/app/ReportsPanel.tsx");
    expect(s).toContain('import { Sparkline } from "@/components/ui/Chart"');
    expect(s).toMatch(/<Sparkline[^>]*dir=\{lang === "ar" \? "rtl" : "ltr"\}[^>]*values=\{k\.daily\.map/);
    expect(s).toContain("summary={");
  });

  it("3135: no chart library, no new npm dependency", () => {
    const pkg = JSON.parse(src("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /chart|d3|victory|nivo|visx|echarts|plotly|apex/i.test(d))).toEqual([]);
    expect(src("src/components/ui/Chart.tsx")).not.toMatch(/from "(?!@\/)[^"]*"/);
  });
});
