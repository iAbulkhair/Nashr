// The two ideas from the site critique of 2026-10-14 that use real data only (docs/system/tests/1880-home-ideas.md):
// the season ribbon (rule 1880) and the stamp the visitor presses (rule 1881).
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PressStamp from "@/components/home/PressStamp";
import { hijriDate } from "@/lib/seasons";
import { RIBBON, daysLeft, nextSeason, riyadhDay, whiteFriday, type HijriOf } from "@/lib/season-ribbon";
import { HOME } from "@/lib/home";

const read = (f: string) => readFileSync(f, "utf8");
const CSS = read("src/components/home/home.module.css");
// The server's Umm al-Qura reader, the same calendar the weekly plan uses (seasons.ts), as the ribbon's reader.
// The ribbon asks for the Riyadh day at UTC midnight, which is 03:00 the same day in Riyadh.
const hijriOf: HijriOf = (d) => hijriDate(d, "Asia/Riyadh");
const at = (iso: string) => new Date(iso);

describe("rule 1880: the season ribbon counts to the next real season", () => {
  it("counts the Riyadh calendar day: 22:00 UTC on 21 September is already the 22nd in Riyadh", () => {
    expect(riyadhDay(at("2026-09-21T22:00:00Z"))).toBe(Date.UTC(2026, 8, 22));
    const n = nextSeason(at("2026-09-21T22:00:00Z"), hijriOf);
    expect(n.name.en).toBe("Saudi National Day");
    expect(n.days).toBe(1);
    expect(n.hijri).toBe(false);
  });
  it("says today on the day itself", () => {
    expect(nextSeason(at("2026-12-02T08:00:00Z"), hijriOf)).toMatchObject({ days: 0, hijri: false, name: { en: "UAE National Day" } });
  });
  it("finds White Friday as the last Friday of November", () => {
    expect(new Date(whiteFriday(2026)).toISOString().slice(0, 10)).toBe("2026-11-27");
    expect(new Date(whiteFriday(2027)).toISOString().slice(0, 10)).toBe("2027-11-26");
    expect(new Date(whiteFriday(2026)).getUTCDay()).toBe(5);
    expect(nextSeason(at("2026-11-01T08:00:00Z"), hijriOf)).toMatchObject({ days: 26, name: { en: "White Friday" } });
  });
  it("finds Ramadan on the Umm al-Qura calendar and marks it Hijri", () => {
    // After the UAE National Day of 2026 the next season is the first of Ramadan 1448.
    const n = nextSeason(at("2026-12-10T08:00:00Z"), hijriOf);
    expect(n.name.en).toBe("Ramadan");
    expect(n.hijri).toBe(true);
    const start = new Date(riyadhDay(at("2026-12-10T08:00:00Z")) + n.days * 864e5 + 12 * 3600e3);
    expect(hijriOf(start)).toMatchObject({ m: 9, day: 1 });
  });
  it("counts in the page's dialect, in both languages", () => {
    expect([0, 1, 2, 3, 10, 11, 120].map((n) => daysLeft("ar", n))).toEqual(["اليوم", "باقي يوم", "باقي يومين", "باقي 3 أيام", "باقي 10 أيام", "باقي 11 يوم", "باقي 120 يوم"]);
    expect([0, 1, 5].map((n) => daysLeft("en", n))).toEqual(["today", "tomorrow", "in 5 days"]);
    for (const k of ["lead", "tail", "hijri"] as const) expect(RIBBON[k].ar && RIBBON[k].en).toBeTruthy();
  });
  it("counts in the browser, keeps its room before then, and promises nothing while the plan is paused", () => {
    const src = read("src/components/home/SeasonRibbon.tsx");
    expect(src).toMatch(/useEffect\(/);
    expect(src).toMatch(/dateFormat\("en", \{ calendar: "islamic-umalqura"/);
    expect(src).toMatch(/\{!paused && <> \{RIBBON\.tail\[lang\]\}<\/>\}/);
    expect(CSS).toMatch(/\.ribbonRow \{ min-height:/);
    expect(read("src/components/home/Steps.tsx")).toMatch(/<SeasonRibbon lang=\{lang\} paused=\{CLAUDE_PAUSED\} \/>/);
  });
});

describe("rule 1881: «موافق.» is a stamp the visitor presses", () => {
  it("is a toggle button with the owner's word, not pressed at first", () => {
    const html = renderToStaticMarkup(h(PressStamp, { label: HOME.finaleWord.ar }));
    expect(html).toMatch(/^<button type="button"[^>]*aria-pressed="false"/);
    expect(html).toContain("موافق.");
  });
  it("thumps only when motion is allowed, with calm easing, and is a 44px target with a focus ring", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html:not\(\[data-motion="off"\]\) \.home \.press\[data-on\] \{ animation: thump/);
    expect(CSS).toMatch(/\.press \{[^}]*min-height: var\(--hit-min\)/);
    expect(CSS).toMatch(/\.press:focus-visible \{/);
    expect(read("src/components/home/Day.tsx")).toMatch(/<PressStamp label=\{word\.stamp\[lang\]\} \/>/);
  });
});
