// UI/UX phase 5b, the rest (docs/system/tests/1212-public-dark-hero.md): public pages follow the dark theme (rules
// 1212-1216, the founder's yes on 2026-10-12, replacing "public pages stay light"), and the home cover gets its call to
// action and freshness chip (rules 1228, 1229). Source-reading checks and static renders.
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG, type ChangeEntry } from "@/lib/changelog";
import { dict, LANGS } from "@/lib/i18n";
import { THEME_COPY } from "@/lib/theme";
import { HERO_START, chipHref, heroStartStrings, latestChange } from "@/lib/home-hero";
import { brightBehind, scribbleColour } from "@/components/ScribbleArt";
import Footer from "@/components/Footer";
import Cover from "@/components/home/Cover";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/ar",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const read = (f: string) => readFileSync(f, "utf8");
const TOKENS = read("src/app/tokens.css");
const DARK = read("src/app/theme-dark.css");
const SCRIBBLE_CSS = read("src/app/scribble.css");
const HOME_CSS = read("src/components/home/home.module.css");
const COVER = "src/components/home/Cover.tsx";
const HERO_COPY = "src/lib/home-hero.ts";
/** The light value of a `--color-*` name in tokens.css. */
const light = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{3,8})`, "i").exec(TOKENS)?.[1]?.toLowerCase();

describe("rule 1212: scribble fills named after the palette paint the role with the same light value", () => {
  const ROLES = { paper: "surface", ground: "background", lilac: "background-muted", muted: "foreground-muted", ink: "primary" };
  it("maps the five palette names onto their roles", () => {
    for (const [name, role] of Object.entries(ROLES)) expect(scribbleColour(name)).toBe(`var(--color-${role})`);
  });
  it("keeps every light page unchanged: each pair has the same value in tokens.css", () => {
    for (const [name, role] of Object.entries(ROLES)) {
      expect(light(name), name).toBeTruthy();
      expect(light(role), `${name} -> ${role}`).toBe(light(name));
    }
  });
  it("leaves lemon, gold, the agents, the roles and any other colour as they are", () => {
    for (const k of ["lemon", "gold", "agent-noor", "surface", "background", "foreground"]) expect(scribbleColour(k)).toBe(`var(--color-${k})`);
    expect(scribbleColour("color-mix(in oklab, var(--color-lemon) 85%, transparent)")).toBe("color-mix(in oklab, var(--color-lemon) 85%, transparent)");
    expect(scribbleColour("none")).toBe("none");
  });
  it("re-points every role it paints in the dark theme", () => {
    for (const role of Object.values(ROLES)) expect(DARK, role).toMatch(new RegExp(`--color-${role}:`));
  });
  it("draws a solid scribbled button's text in the primary's foreground", () => {
    expect(SCRIBBLE_CSS).toMatch(/\.s-btn\s*\{[^}]*color:\s*var\(--color-primary-foreground\)/);
  });
});

describe("rule 1213: the home styles use the roles, except the drawn figures", () => {
  it("uses no palette primitive in a mounted block, except ink and paper on the drawn figures and the dark tag", () => {
    // Dictionary.tsx and StartForm.tsx are not mounted; PR #346 deletes them and their styles, so their blocks are skipped.
    const used = (files: string[]) => new Set(files.flatMap((f) => [...read(f).matchAll(/styles\.([A-Za-z]\w*)/g)].map((m) => m[1])));
    const dir = "src/components/home";
    const all = readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => `${dir}/${f}`);
    const deadFiles = [`${dir}/Dictionary.tsx`, `${dir}/StartForm.tsx`];
    const live = used(all.filter((f) => !deadFiles.includes(f)));
    const deadOnly = [...used(deadFiles)].filter((c) => !live.has(c));
    const css = HOME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    let checked = 0;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      const classes = [...sel.matchAll(/\.([A-Za-z]\w*)/g)].map((c) => c[1]);
      if (classes.some((c) => deadOnly.includes(c))) continue;
      checked++;
      expect(m[2], sel).not.toMatch(/var\(--color-(ground|muted|lilac)\)/);
      if (/var\(--color-(ink|paper)\)/.test(m[2])) expect(sel).toMatch(/^\.doodle\b|^\.who\[data-dark\]/);
    }
    expect(checked).toBeGreaterThan(50);
  });
  it("gives the drawn figures a halo in dark so their ink outline shows on the dark ground, and none in forced colours", () => {
    expect(HOME_CSS).toMatch(/:global\(:root\[data-theme="dark"\]\) \.doodle \{ filter: drop-shadow\(/);
    expect(HOME_CSS).toMatch(/@media \(forced-colors: active\) \{\s*:global\(:root\[data-theme="dark"\]\) \.doodle \{ filter: none; \}\s*\}/);
  });
  it("washes the offer's lemon swash down in dark so the light words over it stay readable", () => {
    expect(HOME_CSS).toMatch(/:global\(:root\[data-theme="dark"\]\) \.sw :global\(\.scribble \.fill\) \{ fill: color-mix\(in oklab, var\(--color-lemon\) 30%, transparent\); \}/);
  });
});

describe("rule 1214: every page under /{lang} follows the theme (tested with rule 1203 in tests/uiux-phase5.test.ts)", () => {
  it("says so in the dark theme's header and no longer says public pages stay light", () => {
    expect(DARK).toMatch(/every page\s*\n?\s*\*?\s*under \/\{lang\}/);
    expect(DARK).not.toMatch(/Public pages stay light/);
  });
});

describe("rule 1215: the footer carries the theme switch", () => {
  for (const lang of LANGS) {
    it(`renders the three choices next to the language switch (${lang})`, () => {
      const html = renderToStaticMarkup(h(Footer, { t: dict[lang], lang }));
      expect(html).toMatch(/role="radiogroup"/);
      expect(html).toContain(`aria-label="${THEME_COPY[lang].label}"`);
      for (const k of ["system", "light", "dark"] as const) expect(html).toContain(THEME_COPY[lang][k]);
    });
  }
});

describe("rule 1216: text on a bright scribble stays ink in both themes", () => {
  it("marks only fills that lie wholly behind their text", () => {
    for (const kind of ["box", "pill", "stamp", "bubble", "cloud"] as const) {
      expect(brightBehind(kind, "lemon"), kind).toBe(true);
      expect(brightBehind(kind, "agent-noor"), kind).toBe(true);
      expect(brightBehind(kind, "paper"), kind).toBe(false);
      expect(brightBehind(kind, "ink"), kind).toBe(false);
    }
    for (const kind of ["swash", "puddle", "tape", "underline"] as const) expect(brightBehind(kind, "lemon"), kind).toBe(false);
  });
  it("paints marked text in the accent's foreground, the ghost button only while hovered or focused", () => {
    expect(SCRIBBLE_CSS).toMatch(/:not\(\.s-btn--ghost\):has\(> \.scribble\[data-bright\]\) \{ color: var\(--color-accent-foreground\); \}/);
    expect(SCRIBBLE_CSS).toMatch(/:where\(\.s-btn--ghost\):is\(:hover, :focus-visible\):has\(> \.scribble\[data-bright\]\) \{ color: var\(--color-accent-foreground\); \}/);
    expect(light("accent-foreground")).toBe(light("ink"));
    expect(/--color-accent-foreground:\s*(#[0-9a-f]+)/i.exec(DARK)?.[1]?.toLowerCase()).toBe(light("ink"));
  });
  it("keeps the home's class names apart, so the cover's trial line never restyles the plans' trial stamp", () => {
    const names = [...HOME_CSS.matchAll(/^\.([A-Za-z][\w-]*)\s*\{/gm)].map((m) => m[1]);
    expect(names.filter((n) => n === "trial")).toHaveLength(1);
    expect(names).toContain("trialLine");
  });
});

describe("rule 1228: the cover's call to action is the signup form with the real trial line", () => {
  for (const lang of LANGS) {
    it(`renders the form, the trial line and no price (${lang})`, () => {
      const html = renderToStaticMarkup(h(Cover, { lang, t: dict[lang] }));
      expect(html).toContain(`action="/${lang}/app/signup"`);
      expect(html).toMatch(/method="get"/);
      expect(html).toMatch(/name="url"/);
      expect(html).toContain(dict[lang].pricing.trial.replace(/&/g, "&amp;"));
      expect(html).not.toMatch(/\b(299|499|999)\b|SAR|ريال/);
    });
  }
  it("names the same trial length the signup gives", () => {
    expect(read("src/lib/auth.ts")).toMatch(/trialEnds: new Date\(now\.getTime\(\) \+ 3 \* 864e5\)/);
    expect(dict.ar.pricing.trial).toMatch(/^تجربة 3 أيام/);
    expect(dict.en.pricing.trial).toMatch(/^3-day free trial/);
  });
});

describe("rule 1229: the freshness chip shows the newest date in the updates feed", () => {
  const e = (date: string): ChangeEntry => ({ date, tag: "new", title: { ar: "", en: "" }, desc: { ar: "", en: "" } });
  it("takes the newest valid date, whatever the order", () => {
    expect(latestChange([e("2026-09-01"), e("2026-10-10"), e("2026-10-02")])?.date).toBe("2026-10-10");
    expect(latestChange([e("not a date"), e("2026-01-05")])?.date).toBe("2026-01-05");
    expect(latestChange([])).toBeNull();
    const max = [...CHANGELOG].map((c) => c.date).sort().at(-1);
    expect(latestChange()?.date).toBe(max);
  });
  for (const lang of LANGS) {
    it(`links to the updates page with a machine-readable date (${lang})`, () => {
      const html = renderToStaticMarkup(h(Cover, { lang, t: dict[lang] }));
      expect(html).toContain(`href="${chipHref(lang)}"`);
      expect(chipHref(lang)).toBe(`/${lang}/updates`);
      expect(html).toContain(HERO_START.chip[lang]);
      expect(html).toContain(`<time dateTime="${latestChange()!.date}">`);
    });
  }
  it("never types a date by hand", () => {
    for (const f of [COVER, HERO_COPY]) expect(read(f), f).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });
  it("keeps its words out of src/lib/home.ts and names no model, maker or number", () => {
    expect(read(COVER)).toMatch(/from "@\/lib\/home-hero"/);
    expect(read("src/lib/home.ts")).not.toMatch(/home-hero|HERO_START/);
    for (const s of heroStartStrings()) {
      expect(s).not.toMatch(/claude|anthropic|openai|gpt|gemini|sonnet|opus|llm|كلود|أنثروبيك/i);
      expect(s).not.toMatch(/\d/);
    }
  });
});
