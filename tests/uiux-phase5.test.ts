// UI/UX phase 5 (docs/reports/2026-10-10-supastarter-uiux-report.md §5.2, docs/system/tests/1200-uiux-phase5.md): the
// raw-colour codemod, the lint rule that keeps raw colours out, the theme-aware roles with their dark values, the
// no-flash head script, the viewer's choice in a cookie with its toggle, and WCAG AA contrast in both themes.
// Source-reading checks, static renders and the pure helpers driven directly (no DOM in this suite).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Linter, type ESLint } from "eslint";
import plugin, { errors as errorLevels, warnings as warnLevels, semanticColour, RAW_COLOUR } from "../eslint-rules/thakeen-ui.mjs";
import { THEME_COOKIE, THEME_PREFS, THEME_SCRIPT, THEMED_PATH, THEME_COPY, isThemePref, readThemePref, resolveTheme, themeCookie } from "@/lib/theme";
import ThemeToggle from "@/components/ui/ThemeToggle";
import { tabStep } from "@/components/ui/Tabs";

const read = (f: string) => readFileSync(f, "utf8");
/** The source without block comments and `//` line comments (a `//` after a colon is a URL). */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const thakeenUi = plugin as unknown as ESLint.Plugin;
const errors = errorLevels as Linter.RulesRecord;

describe("rule 1200: the codemod moved every raw palette colour onto a semantic role", () => {
  it("maps each raw utility to the role that means the same thing in light", () => {
    const cases: [string, string, string][] = [
      ["text-ink", "", "text-foreground"],
      ["text-muted", "", "text-foreground-muted"],
      ["text-ink/70", "", "text-foreground-muted"],
      ["bg-paper", "", "bg-surface"],
      ["bg-white", "", "bg-surface"],
      ["bg-ground", "", "bg-background"],
      ["bg-lilac", "", "bg-background-muted"],
      ["border-ink", "", "border-border-strong"],
      ["border-ink/15", "", "border-border"],
      ["bg-ink/40", "", "bg-overlay"],
      ["text-paper", "", "text-inverse-foreground"],
      ["text-lilac", "", "text-inverse-muted"],
      ["ring-ink", "", "ring-ring"],
      ["bg-ink/5", "", "bg-foreground/5"],
      ["border-ink/30", "", "border-foreground/30"],
      ["text-paper/70", "", "text-inverse-foreground/70"],
      // An ink panel with paper text is the inverse surface; an ink dot or bar is the foreground colour.
      ["bg-ink", "rounded-xl bg-ink p-4 text-paper", "bg-inverse"],
      ["bg-ink", "h-2 w-2 rounded-full bg-ink", "bg-foreground"],
      // Ink text on a fixed bright fill stays ink in both themes.
      ["text-ink", "rounded-full bg-lemon px-2 text-ink", "text-accent-foreground"],
      ["text-ink", "bg-agent-sami text-ink", "text-accent-foreground"],
      // A lemon tint is not a fixed fill: its text follows the theme.
      ["text-ink", "bg-lemon/20 text-ink", "text-foreground"],
    ];
    for (const [raw, ctx, want] of cases) expect(semanticColour(raw, ctx), `${raw} in "${ctx}"`).toBe(want);
    for (const role of ["text-foreground", "bg-surface", "border-border", "bg-lemon", "text-danger", "bg-agent-noor"]) expect(semanticColour(role), role).toBeUndefined();
  });

  it("a second run finds nothing to change in src/ (the codemod is idempotent and the tree is clean)", () => {
    const out = execFileSync(process.execPath, ["scripts/semantic-colours.mjs", "--check"], { encoding: "utf8" });
    expect(out).toMatch(/would change 0 classes in 0 files/);
  });

  it("no raw palette utility is left in a .tsx under src/, except the scribble art's own class names", () => {
    const files = (readdirSync("src", { recursive: true }) as string[]).filter((f) => f.endsWith(".tsx")).map((f) => join("src", f));
    const left: string[] = [];
    for (const f of files) {
      if (f === join("src", "components", "ScribbleArt.tsx")) continue;
      for (const m of read(f).matchAll(/(?<![\w\-/:[])((?:[\w-]+:)*-?(?:bg|text|border|ring|divide|accent|fill|stroke)-(?:ink|paper|white|ground|lilac|muted)(?:\/\d+)?)(?![\w\-/])/g)) {
        if (RAW_COLOUR.test(m[1].replace(/^(?:[\w-]+:)*-?/, ""))) left.push(`${f}: ${m[1]}`);
      }
    }
    expect(left).toEqual([]);
  });
});

describe("rule 1201: a raw colour fails the lint", () => {
  const linter = new Linter({ configType: "flat" });
  const lint = (code: string) => linter.verify(code, [{
    files: ["**/*.jsx"],
    plugins: { "thakeen-ui": thakeenUi },
    rules: errors,
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  }], "x.jsx");

  it("is an error (not a warning), registered for src next to the four warnings", () => {
    expect(errors).toEqual({ "thakeen-ui/no-raw-colour": "error" });
    expect(Object.keys(warnLevels)).not.toContain("thakeen-ui/no-raw-colour");
    const cfg = read("eslint.config.mjs");
    expect(cfg).toMatch(/import thakeenUi, \{ errors as thakeenUiErrors, warnings as thakeenUiWarnings \} from "\.\/eslint-rules\/thakeen-ui\.mjs";/);
    expect(cfg).toMatch(/\{ files: \["src\/\*\*\/\*\.\{ts,tsx\}"\], plugins: \{ "thakeen-ui": thakeenUi \}, rules: thakeenUiErrors \}/);
  });

  it("names the raw token and the role to use instead", () => {
    const found = lint(`const a = <p className="mt-1 text-ink">x</p>;`);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe(2);
    expect(found[0].message).toContain("`text-ink`");
    expect(found[0].message).toContain("`text-foreground`");
  });

  it("catches variants, opacity, template strings and arbitrary colour values", () => {
    expect(lint("const a = <p className=\"hover:bg-lilac/60 md:text-muted\">x</p>;")).toHaveLength(2);
    expect(lint("const a = (on) => `rounded ${on ? \"bg-ink text-paper\" : \"\"} border-ink/20`;")).toHaveLength(3);
    expect(lint(`const a = <p className="bg-[#2b193d] text-[rgb(0,0,0)]">x</p>;`)).toHaveLength(2);
    expect(lint(`const a = <p className="border-[var(--color-ink)]">x</p>;`)).toHaveLength(1);
  });

  it("passes the semantic roles, the fixed accent fills and the scribble SVG shapes' own class names", () => {
    expect(lint(`const a = <p className="bg-surface text-foreground border-border bg-lemon text-accent-foreground bg-inverse text-inverse-foreground">x</p>;`)).toEqual([]);
    expect(lint(`const a = <svg><path className="ink ring-paper" /><circle className="ring-paper" /></svg>;`)).toEqual([]);
    expect(lint(`const a = "a single word: muted";`)).toEqual([]);
  });

  it("the lemon-on-ink warning reads the codemod's bg-foreground bar as the ink fill it was", () => {
    const warn = (code: string) => linter.verify(code, [{ files: ["**/*.jsx"], plugins: { "thakeen-ui": thakeenUi }, rules: warnLevels as Linter.RulesRecord, languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } }], "x.jsx");
    expect(warn("const a = (x) => <div className={`h-full ${x ? \"bg-foreground\" : \"bg-lemon\"}`} />;").map((m) => m.ruleId)).toEqual([]);
  });
});

/** Every `--name: value;` in a stylesheet, last one wins. */
const vars = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const tokensCss = read("src/app/tokens.css");
const darkCss = read("src/app/theme-dark.css");
const globals = read("src/app/globals.css");

describe("rule 1202: the roles follow the theme; the dark values live in their own sheet", () => {
  it("the roles are in a non-inline @theme block, so each utility reads the variable and the dark sheet re-points it", () => {
    const blocks = [...globals.matchAll(/@theme( inline)? \{([\s\S]*?)\n\}/g)];
    const inline = blocks.filter((b) => b[1]).map((b) => b[2]).join("\n");
    const live = blocks.filter((b) => !b[1]).map((b) => b[2]).join("\n");
    for (const role of ["background", "background-muted", "surface", "foreground", "foreground-muted", "border", "border-strong", "inverse", "inverse-foreground", "inverse-muted", "accent-foreground", "overlay", "ring", "danger"]) {
      expect(live, role).toMatch(new RegExp(`--color-${role}:`));
      expect(inline, role).not.toMatch(new RegExp(`--color-${role}:`));
    }
    expect(globals).toMatch(/@import "\.\/tokens\.css";\n@import "\.\/theme-dark\.css";/);
  });

  it("the dark sheet only re-points names the light theme already has, under :root[data-theme=\"dark\"] with color-scheme dark", () => {
    expect(darkCss).toMatch(/^:root\[data-theme="dark"\] \{\n  color-scheme: dark;/m);
    expect(darkCss.replace(/\/\*[\s\S]*?\*\//g, "").match(/\{/g)?.length).toBe(1);
    const light = { ...vars(tokensCss), ...vars(globals) };
    const dark = vars(darkCss);
    expect(Object.keys(dark).length).toBeGreaterThan(40);
    for (const k of Object.keys(dark)) expect(light[k], k).toBeDefined();
    // Primitives, agent colours and lemon never change with the theme.
    for (const k of Object.keys(dark)) expect(k, k).not.toMatch(/^--primitive-|^--color-(agent-|lemon|gold|ink|paper|lilac|ground|muted\b)/);
  });

  it("tokens.css stays the light sheet that design-tokens.json is checked against", () => {
    expect(tokensCss).not.toMatch(/data-theme|prefers-color-scheme/);
    expect(globals).toMatch(/html \{[^}]*color-scheme: light;/);
  });

  it("text on a solid bright fill is ink in both themes, at zero specificity", () => {
    expect(globals).toMatch(/:where\(\.bg-lemon, \.bg-gold, \.bg-agent-noor, \.bg-agent-sami, \.bg-agent-razan, \.bg-agent-dana, \.bg-agent-layan, \.bg-agent-reem, \.bg-agent-you\) \{ color: var\(--color-accent-foreground\); \}/);
    expect(globals).toMatch(/:where\(\.bg-inverse\) :focus-visible \{ outline-color: var\(--color-ring-inverse\); \}/);
    const avatar = read("src/components/app/AgentAvatar.tsx");
    expect(avatar).toMatch(/ON_DARK\.has\(id\) \? "text-inverse-foreground" : "text-accent-foreground"/);
  });

  it("scribble art and the component classes draw with the roles", () => {
    const scribble = read("src/app/scribble.css");
    expect(scribble).toMatch(/stroke: var\(--color-foreground\);/);
    expect(scribble).toMatch(/\.s-art \.cap \{ fill: var\(--s-fill, var\(--color-background\)\);/);
    expect(globals).toMatch(/\.switch\[aria-checked="true"\] \.switch-track \{ background: var\(--color-primary\);/);
    expect(globals).toMatch(/\.badge-inverse \{ background: var\(--color-inverse-surface\); color: var\(--color-inverse-foreground\); \}/);
  });
});

/** Runs the head script against a stub page and returns the theme it set. */
function runHead(cookie: string, path: string, systemDark: boolean, throws = false) {
  const attrs: Record<string, string> = {};
  const document = { cookie, documentElement: { setAttribute: (n: string, v: string) => { if (throws) throw new Error("x"); attrs[n] = v; } } };
  const window = { matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && systemDark }) };
  new Function("document", "window", "location", THEME_SCRIPT)(document, window, { pathname: path });
  return attrs["data-theme"];
}

describe("rule 1203: the theme is set before the first paint (every page in the language since rule 1214)", () => {
  it("the root layout sends light, runs the head script and lets only that attribute differ at hydration", () => {
    const layout = read("src/app/[lang]/layout.tsx");
    expect(layout).toMatch(/<html lang=\{lang\} dir=\{t\.dir\} translate="no" data-theme="light" suppressHydrationWarning /);
    expect(layout).toMatch(/<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: THEME_SCRIPT \}\} \/>\s*<\/head>/);
    expect(code("src/app/[lang]/layout.tsx")).not.toMatch(/cookies\(\)/);
  });

  it("the head script follows the choice, the device and the path", () => {
    expect(runHead("", "/ar/app", true)).toBe("dark");
    expect(runHead("", "/en/app/tasks", false)).toBe("light");
    expect(runHead("a=1; nashr_theme=dark; b=2", "/en/admin/users", false)).toBe("dark");
    expect(runHead("thakeen_theme=light", "/ar/app", true)).toBe("light");
    expect(runHead("nashr_theme=system", "/ar/app/settings/account", true)).toBe("dark");
    // Rule 1214: public pages follow the choice too; light stays the default for a light device with no choice.
    for (const p of ["/ar", "/en/pricing", "/ar/blog/x", "/en/apps", "/ar/administer"]) {
      expect(runHead("thakeen_theme=dark", p, false), p).toBe("dark");
      expect(runHead("", p, false), p).toBe("light");
      expect(runHead("nashr_theme=light", p, true), p).toBe("light");
    }
    // Outside the language segment (the OAuth consent page) stays light.
    for (const p of ["/oauth/authorize", "/", "/arx", "/fr/app"]) expect(runHead("nashr_theme=dark", p, true), p).toBe("light");
    // A made-up value is "system"; an error leaves the light default.
    expect(runHead("nashr_theme=purple", "/ar/app", false)).toBe("light");
    expect(runHead("nashr_theme=purple", "/ar/app", true)).toBe("dark");
    expect(() => runHead("nashr_theme=dark", "/ar/app", true, true)).not.toThrow();
  });

  it("the pure helpers agree with the script", () => {
    for (const pref of THEME_PREFS) for (const sys of [true, false]) for (const p of ["/ar/app", "/en/admin", "/ar", "/en/pricing"]) {
      expect(resolveTheme(pref, sys, p), `${pref} ${sys} ${p}`).toBe(runHead(`${THEME_COOKIE}=${pref}`, p, sys));
    }
    expect(THEMED_PATH.test("/ar/app")).toBe(true);
    expect(THEMED_PATH.test("/en/admin/log")).toBe(true);
    expect(THEMED_PATH.test("/ar/apps")).toBe(true);
    expect(THEMED_PATH.test("/en")).toBe(true);
    expect(THEMED_PATH.test("/oauth/authorize")).toBe(false);
    expect(THEMED_PATH.test("/arabic")).toBe(false);
  });

  it("ThemeScope re-applies after device changes and a new choice, and puts light back on the way out", () => {
    const scope = read("src/components/ThemeScope.tsx");
    expect(scope).toMatch(/^"use client";/);
    expect(scope).toMatch(/addEventListener\?\.\("change", sync\)/);
    expect(scope).toMatch(/window\.addEventListener\(THEME_EVENT, sync\)/);
    expect(scope).toMatch(/applyTheme\("light"\);\n\s*\};/);
    // Rule 1214: one ThemeScope in the language layout serves every page; the app and the console no longer mount one,
    // so leaving the app for a public page keeps the viewer's theme.
    expect(read("src/app/[lang]/layout.tsx").match(/<ThemeScope \/>/g)).toHaveLength(1);
    expect(read("src/app/[lang]/layout.tsx")).toMatch(/<body>\s*<ThemeScope \/>\s*\{children\}\s*<\/body>/);
    expect(read("src/app/[lang]/app/layout.tsx")).not.toMatch(/ThemeScope/);
    expect(read("src/app/[lang]/admin/layout.tsx")).not.toMatch(/ThemeScope/);
  });
});

describe("rule 1204: the viewer's choice is a cookie on this browser, set from the toggle", () => {
  it("reads only the three words and writes a year-long, site-wide, lax cookie, Secure on https", () => {
    expect(readThemePref(undefined)).toBe("system");
    expect(readThemePref("thakeen_theme=dark")).toBe("dark");
    // Expand release (rule 1812): the old name still reads, and the new one wins when both are present.
    expect(readThemePref("nashr_theme=dark")).toBe("dark");
    expect(readThemePref("nashr_theme=dark; thakeen_theme=light")).toBe("light");
    expect(readThemePref("x_thakeen_theme=dark")).toBe("system");
    expect(readThemePref("x_nashr_theme=dark")).toBe("system");
    expect(readThemePref("nashr_theme=dark%3Bx")).toBe("system");
    expect(isThemePref("light")).toBe(true);
    expect(isThemePref("auto")).toBe(false);
    expect(themeCookie("dark", true)).toBe("thakeen_theme=dark; path=/; max-age=31536000; samesite=lax; secure");
    expect(themeCookie("system", false)).toBe("thakeen_theme=system; path=/; max-age=31536000; samesite=lax");
  });

  it("no server code reads or stores it: no route, no profile field, no stored shape", () => {
    const files = (readdirSync("src", { recursive: true }) as string[]).filter((f) => /\.(?:ts|tsx)$/.test(f)).map((f) => join("src", f));
    // cookie-names.ts only names it (rule 1810); theme.ts is the one reader, and only the browser runs it.
    const users = files.filter((f) => /(?:nashr|thakeen)_theme|THEME_COOKIE/.test(code(f)));
    expect(users.sort()).toEqual([join("src", "lib", "cookie-names.ts"), join("src", "lib", "theme.ts")]);
    for (const f of files.filter((x) => x.startsWith(join("src", "app", "api")))) expect(read(f), f).not.toMatch(/@\/lib\/theme/);
  });

  it("the toggle is a radio group of three, the server renders System, in both languages", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(h(ThemeToggle, { lang }));
      expect(html).toContain(`role="radiogroup" aria-label="${THEME_COPY[lang].label}"`);
      expect(html.match(/role="radio"/g)).toHaveLength(3);
      expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`aria-checked="true" tabindex="0"[^>]*>${THEME_COPY[lang].system}<`));
      expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
      expect(html).toContain("min-h-[var(--hit-min)]");
    }
  });

  it("the arrows move the way they point in both directions (tabStep, rule 1113)", () => {
    expect(read("src/components/ui/ThemeToggle.tsx")).toMatch(/tabStep\(e\.key, i, THEME_PREFS\.length, rtl\)/);
    expect(tabStep("ArrowLeft", 0, 3, true)).toBe(1);
    expect(tabStep("ArrowRight", 0, 3, false)).toBe(1);
  });

  it("is in the app's account menu, in Settings > Account and in the console's rail", () => {
    expect(read("src/components/app/Sidebar.tsx")).toMatch(/footer=\{<div className="grid gap-2 px-2"><ThemeToggle lang=\{lang\} size="sm"/);
    const account = read("src/components/app/settings/AccountSettings.tsx");
    expect(account).toMatch(/<SettingsCard title=\{THEME_COPY\[lang\]\.title\} sub=\{THEME_COPY\[lang\]\.sub\}>\s*<ThemeToggle lang=\{lang\}/);
    expect(read("src/components/admin/AdminNav.tsx")).toMatch(/<ThemeToggle lang=\{lang\} size="sm"/);
  });
});

/** sRGB channel and alpha from a hex or `rgb(r g b / a)` value. */
function parse(v: string): number[] {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)).concat(1);
  m = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1];
  throw new Error(`not a colour: ${v}`);
}
const over = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c: number[]) => {
  const [r, g, b] = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("rule 1205: WCAG AA in both themes", () => {
  const light: Record<string, string> = { ...vars(tokensCss), "--color-inverse": vars(tokensCss)["--color-inverse-surface"] };
  const dark: Record<string, string> = { ...light, ...vars(darkCss) };
  const themes = { light, dark } as const;
  // [foreground, background, minimum]: text 4.5:1; focus rings, input borders and strong borders 3:1 (1.4.11).
  const PAIRS: [string, string, number][] = [
    ["foreground", "background", 4.5], ["foreground", "surface", 4.5], ["foreground", "background-muted", 4.5], ["foreground", "surface-muted", 4.5], ["foreground", "popover", 4.5],
    ["foreground-muted", "background", 4.5], ["foreground-muted", "surface", 4.5], ["foreground-muted", "background-muted", 4.5],
    ["foreground-subtle", "surface", 4.5], ["foreground-subtle", "background", 4.5],
    ["inverse-foreground", "inverse", 4.5], ["inverse-muted", "inverse", 4.5], ["primary-foreground", "primary", 4.5], ["accent-foreground", "accent", 4.5],
    ["danger", "surface", 4.5], ["danger", "background", 4.5], ["danger", "background-muted", 4.5], ["danger-foreground", "danger", 4.5], ["danger", "danger-tint", 4.5],
    ["success", "surface", 4.5], ["success-foreground", "success", 4.5], ["success", "success-tint", 4.5],
    ["warning", "surface", 4.5], ["warning-foreground", "warning", 4.5], ["warning", "warning-tint", 4.5],
    ["text-accent", "surface", 4.5], ["info", "surface", 4.5], ["foreground", "notice-bg", 4.5], ["foreground", "info-tint", 4.5],
    ["ring", "background", 3], ["ring", "surface", 3], ["ring", "background-muted", 3], ["ring-inverse", "inverse", 3],
    ["border-input", "surface", 3], ["border-input", "background", 3], ["border-strong", "surface", 3], ["border-strong", "background", 3],
  ];
  const COMPONENT: [string, string, number][] = [["button-fg", "button-bg", 4.5], ["button-fg", "button-hover-bg", 4.5], ["input-focus-ring", "input-bg", 3], ["input-border", "input-bg", 3]];

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: every text pair is 4.5:1 and every ring and input border 3:1 (a translucent colour composited first)`, () => {
      const c = (k: string) => parse(t[`--color-${k}`]);
      const low: string[] = [];
      for (const [f, b, min] of PAIRS) {
        const bg = over(c(b), c("surface"));
        const r = ratio(over(c(f), bg), bg);
        if (r < min) low.push(`${f} on ${b}: ${r.toFixed(2)}`);
      }
      for (const [f, b, min] of COMPONENT) {
        const bg = parse(t[`--${b}`]);
        const r = ratio(over(parse(t[`--${f}`]), bg), bg);
        if (r < min) low.push(`${f} on ${b}: ${r.toFixed(2)}`);
      }
      expect(low).toEqual([]);
    });
  }

  it("dark: each chart series is at least 3:1 on the card surface (rule 967's bar)", () => {
    for (let i = 1; i <= 5; i++) expect(ratio(parse(dark[`--chart-${i}`]), parse(dark["--color-surface"])), `chart-${i}`).toBeGreaterThanOrEqual(3);
  });

  it("contrast does not depend on direction: the same roles paint the RTL and the LTR tree", () => {
    expect(darkCss).not.toMatch(/\[dir=|:dir\(|\[lang=/);
  });
});
