// The founder-approved Saudi-dialect review of the site critique's Arabic (docs/system/tests/1888-dialect-review.md).
import { readdirSync, readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENTS_VOICE } from "@/lib/pages-voice";
import { BANTER, SCENES } from "@/lib/home";
import { SIGNUP_NEXT } from "@/lib/signup-preview";
import { RIBBON } from "@/lib/season-ribbon";
import { generateMetadata } from "@/app/[lang]/agents/page";
import NotFound from "@/app/[lang]/not-found";

const read = (p: string) => readFileSync(p, "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.(ts|tsx)$/.test(d.name) ? [`${dir}/${d.name}`] : []));

describe("rule 1888: the Arabic the critique added reads Saudi", () => {
  it("never uses the Levantine/Egyptian future «بـ» + verb: Noor «تقرا», not «بتقرا»", () => {
    expect(SIGNUP_NEXT.reads.ar).toBe("نور تقرا:");
    for (const f of walk("src")) expect(read(f), f).not.toMatch(/بتقرا|بتكتب|بتسوي/);
  });
  it("names the signup steps and the ribbon's note in dialect", () => {
    expect(SIGNUP_NEXT.steps.ar[0]).toBe("تفعّل إيميلك من رابط نرسله لك.");
    expect(SIGNUP_NEXT.steps.ar[1]).toContain("وتتأكد من رابطك");
    expect(RIBBON.hijri.ar).toBe("حسب تقويم أم القرى، وممكن يختلف يوم حسب الرؤية.");
    expect(JSON.stringify(BANTER)).toContain("ثلاث عملاء قالوا نفس الملاحظة.");
    expect(JSON.stringify(SCENES)).toContain("والعملاء يتركون السلة");
  });
  it("says the not-found line in dialect on both 404 pages", () => {
    expect(renderToStaticMarkup(h(NotFound))).toContain("الرابط اللي فتحته مو موجود، أو انكتب غلط.");
    expect(read("src/app/global-not-found.tsx")).toContain("الرابط اللي فتحته مو موجود، أو انكتب غلط.");
  });
});

describe("rule 1889: the agent pages' headings fit every agent", () => {
  it("addresses the visitor, gender-neutral, never the agent in the masculine", () => {
    expect(AGENTS_VOICE.ar.does).toBe("وش تستلم");
    expect(AGENTS_VOICE.ar.asks).toBe("جرّب تطلب");
    for (const k of Object.keys(AGENTS_VOICE.ar) as (keyof typeof AGENTS_VOICE.ar)[]) expect(AGENTS_VOICE.ar[k], k).not.toMatch(/يسلّمك|اطلب\b/);
  });
});

describe("rule 1890: /agents shares the words its heading shows", () => {
  for (const lang of ["ar", "en"] as const) {
    it(`${lang}: the title and description come from AGENTS_VOICE`, async () => {
      const m = await generateMetadata({ params: Promise.resolve({ lang }) });
      expect(String(m.title)).toContain(AGENTS_VOICE[lang].title);
      expect(m.description).toBe(AGENTS_VOICE[lang].sub);
    });
  }
  it("keeps only eyebrow, title and sub in SITE.agents", () => {
    expect(read("src/lib/site.ts")).toMatch(/agents: \{ eyebrow: string; title: string; sub: string \};/);
    expect(read("src/lib/site.ts")).not.toMatch(/startWith/);
  });
});
