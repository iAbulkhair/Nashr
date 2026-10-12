// UI/UX phase 1 (docs/reports/2026-10-10-supastarter-uiux-report.md §4.1-4.3, §4.14-4.17, §5-§8): semantic tokens,
// the primitives in src/components/ui, the first screens moved onto them and the four lint warnings. Source-reading
// checks (no DOM in this suite), static renders of the primitives and the pure helpers driven directly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Linter, type ESLint } from "eslint";
import plugin, { warnings as ruleLevels, baseOf, PHYSICAL } from "../eslint-rules/thakeen-ui.mjs";
import { buttonClass } from "@/components/ui/button-class";
import Button from "@/components/ui/Button";
import { Field, Input, joinIds } from "@/components/ui/Field";
import Switch from "@/components/ui/Switch";
import Badge from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
import { toastStore, useToast, TOAST_MS } from "@/components/ui/Toast";
import { promptGate } from "@/components/ui/Dialog";
import { Money, Time } from "@/components/ui/Time";
import TrialBanner from "@/components/app/TrialBanner";
import { BRAND_TZ, formatMoney, formatNumber, formatTime, isoFor, plural } from "@/lib/format";

// The plugin is plain JavaScript (eslint.config.mjs loads it); these give it ESLint's types here.
const thakeenUi = plugin as unknown as ESLint.Plugin;
const warnings = ruleLevels as Linter.RulesRecord;

const read = (f: string) => readFileSync(f, "utf8");
const tokens = read("src/app/tokens.css");
const globals = read("src/app/globals.css");
const ARABIC_DIGITS = /[٠-٩۰-۹]/;

/** A token's literal value in tokens.css. */
const tokenValue = (name: string) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

type RGB = [number, number, number];
const hex = (v: string): RGB => {
  const s = v.replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
};
/** `rgb(43 25 61 / 0.65)` laid over a ground. */
const over = (v: string, ground: RGB): RGB => {
  const m = v.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  if (!m) return hex(v);
  const a = Number(m[4]);
  return [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + ground[k] * (1 - a))) as RGB;
};
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const WHITE: RGB = [255, 255, 255];

describe("rule 1080: semantic tokens, expand only, mirrored in assets/design-tokens.json", () => {
  const NEW = ["foreground-muted", "foreground-subtle", "border", "border-input", "border-strong", "surface-muted", "popover", "overlay", "success", "success-foreground", "success-tint", "warning", "warning-foreground", "warning-tint", "info", "info-tint", "danger-tint", "text-accent", "notice-bg", "notice-border", "ring-inverse"];

  it("tokens.css defines each new colour and the size tokens", () => {
    for (const n of NEW) expect(tokenValue(`color-${n}`), n).toBeTruthy();
    expect(tokenValue("hit-min")).toBe("44px");
    expect(tokenValue("hit-floor")).toBe("24px");
    expect(tokenValue("radius-card")).toBe("0.75rem");
    expect(tokenValue("leading-body")).toBe("1.5");
  });

  it("Tailwind sees them through @theme inline, and Arabic gets the taller line and the larger floor", () => {
    for (const n of ["foreground-muted", "foreground-subtle", "border-input", "surface-muted", "popover", "overlay", "success", "success-tint", "warning", "warning-tint", "info-tint", "danger-tint", "notice-bg", "notice-border"]) {
      expect(globals, n).toMatch(new RegExp(`--color-${n}:`));
    }
    expect(globals).toMatch(/:lang\(ar\) \{[^}]*--leading-body: 1\.7;[^}]*--text-xs-min: 0\.8125rem;/);
  });

  it("the old tokens keep their values (expand only)", () => {
    expect(tokenValue("color-danger")).toBe("#cc0000");
    expect(tokenValue("color-ink")).toBe("#2b193d");
    expect(tokenValue("color-ring")).toBe("#2b193d");
    expect(tokens).toMatch(/--primitive-color-lemon: #f9f871;/);
    // Phase 2 (rule 1115) moved `.card` and the body's line height onto the tokens; uiux-phase2.test.ts pins that.
    expect(globals).toMatch(/\.card \{[^}]*var\(--radius-card\)/);
  });

  it("every text pair reaches WCAG 2.2 AA (4.5:1) on its ground", () => {
    const ink = hex(tokens.match(/--primitive-color-ink: (#[0-9a-f]+);/i)![1]);
    const lemon = hex(tokens.match(/--primitive-color-lemon: (#[0-9a-f]+);/i)![1]);
    const danger = hex(tokens.match(/--primitive-color-danger: (#[0-9a-f]+);/i)![1]);
    const success = hex(tokenValue("primitive-color-success")!);
    const warning = hex(tokenValue("primitive-color-warning")!);
    const warningTint = hex(tokenValue("primitive-color-warning-tint")!);
    const subtle = over(tokenValue("color-foreground-subtle")!, WHITE);
    expect(contrast(subtle, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(tokenValue("color-foreground-muted")!), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(success, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(success, over("rgb(31 122 77 / 0.1)", WHITE))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warning, warningTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(danger, over(tokenValue("color-danger-tint")!, WHITE))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lemon, ink)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("rule 1081: focus stays visible on ink", () => {
  it("a focused control inside an ink surface draws the lemon ring, after the global rule so it wins", () => {
    const global = globals.indexOf(":focus-visible {");
    const inverse = globals.indexOf(':where(.bg-ink, .card-inverse, [data-surface="inverse"]) :focus-visible');
    expect(global).toBeGreaterThan(-1);
    expect(inverse).toBeGreaterThan(global);
    expect(globals.slice(inverse, inverse + 200)).toMatch(/outline-color: var\(--color-ring-inverse\)/);
  });
});

describe("rules 1082-1083: Button, and 44px targets", () => {
  it("buttonClass composes the old classes with a height step", () => {
    expect(buttonClass({})).toBe("btn btn-primary btn-h-md");
    expect(buttonClass({ variant: "danger", size: "sm" })).toBe("btn btn-danger btn-sm btn-h-sm");
    expect(buttonClass({ variant: "ghost", size: "lg", block: true, className: "mt-2" })).toBe("btn btn-ghost btn-lg btn-h-lg btn-block mt-2");
  });

  it("a Button is type=button unless told, and busy says so without losing its label", () => {
    expect(renderToStaticMarkup(h(Button, null, "Save"))).toMatch(/^<button type="button" class="btn btn-primary btn-h-md[^"]*">/);
    const busy = renderToStaticMarkup(h(Button, { type: "submit", loading: true, loadingText: "Saving", children: "Save" }));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain("Saving");
    const pill = renderToStaticMarkup(h(Button, { type: "submit", variant: "pill", seed: "t-1", children: "Sign in" }));
    expect(pill).toMatch(/class="s-btn/);
    expect(pill).toContain("scribble");
  });

  it("the default height and every control reach 44px; the close buttons are 44px squares", () => {
    expect(globals).toMatch(/\.btn-h-md \{[^}]*min-height: var\(--hit-min\)/);
    expect(globals).toMatch(/\.control \{[^}]*min-height: var\(--hit-min\)/);
    for (const f of ["src/components/ui/Dialog.tsx", "src/components/ui/Toast.tsx"]) expect(read(f), f).toMatch(/h-11 w-11/);
  });
});

describe("rule 1084: Field ties the label, hint and error to its control", () => {
  it("label for=id, described by hint and error, invalid and required", () => {
    const html = renderToStaticMarkup(h(Field, { label: "Email", hint: "Work address", error: "Wrong address", required: true, id: "em", children: h(Input, { type: "email", name: "email" }) }));
    expect(html).toContain('<label for="em"');
    expect(html).toMatch(/<input[^>]*id="em"/);
    expect(html).toMatch(/aria-describedby="em-hint em-error"/);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<input[^>]*required=""/);
    expect(html).toMatch(/<p[^>]*id="em-error"[^>]*role="alert"|<p[^>]*role="alert"[^>]*id="em-error"/);
  });

  it("an email, URL or password input reads left to right; free text follows its content", () => {
    expect(renderToStaticMarkup(h(Input, { type: "email" }))).toContain('dir="ltr"');
    expect(renderToStaticMarkup(h(Input, { type: "password" }))).toContain('dir="ltr"');
    expect(renderToStaticMarkup(h(Input, {}))).toContain('dir="auto"');
  });

  it("joinIds drops the empty ids", () => {
    expect(joinIds("a", undefined, "", false, "b")).toBe("a b");
    expect(joinIds(undefined, null)).toBeUndefined();
  });
});

describe("rule 1085: Switch", () => {
  it("is a role=switch button with its state and name", () => {
    const html = renderToStaticMarkup(h(Switch, { checked: true, onChange: () => {}, label: "Auto handoff" }));
    expect(html).toMatch(/^<button type="button" role="switch" aria-checked="true" aria-label="Auto handoff"/);
  });

  it("the governance and working-days panels use it instead of their own toggles", () => {
    for (const f of ["src/components/app/GovernancePanel.tsx", "src/components/app/WorkingDaysPanel.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/import Switch from "@\/components\/ui\/Switch";/);
      expect(src, f).not.toMatch(/function Toggle\(/);
    }
  });
});

describe("rules 1086-1087: Badge and Callout", () => {
  it("each badge tone has its class and none is lemon", () => {
    const map: Record<string, string> = { neutral: "badge-neutral", info: "badge-primary", success: "badge-success", warning: "badge-warning", danger: "badge-danger", inverse: "badge-inverse" };
    for (const [tone, cls] of Object.entries(map)) {
      const html = renderToStaticMarkup(h(Badge, { tone: tone as never }, "x"));
      expect(html, tone).toContain(cls);
      expect(html, tone).not.toMatch(/lemon/);
    }
  });

  it("a danger callout is an alert, the others a status, and the role can be set; the icon is hidden", () => {
    expect(renderToStaticMarkup(h(Callout, { tone: "danger" }, "Failed"))).toMatch(/role="alert"/);
    expect(renderToStaticMarkup(h(Callout, { tone: "success" }, "Saved"))).toMatch(/role="status"/);
    const note = renderToStaticMarkup(h(Callout, { tone: "notice", role: "note" }, "Read only"));
    expect(note).toMatch(/role="note"/);
    expect(note).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(read("src/components/app/ReadOnlyNote.tsx")).toMatch(/<Callout tone="notice" role="note"/);
  });
});

describe("rule 1088: toasts", () => {
  it("keep at most three, replace the same words, and dismiss by id", () => {
    const s = toastStore();
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    const a = s.push("success", "Saved");
    s.push("info", "One");
    s.push("info", "Two");
    s.push("info", "Three");
    expect(s.list().map((t) => t.text)).toEqual(["One", "Two", "Three"]);
    s.push("info", "Two");
    expect(s.list().map((t) => t.text)).toEqual(["One", "Three", "Two"]);
    s.dismiss(a);
    expect(s.list()).toHaveLength(3);
    s.dismiss(s.list()[0].id);
    expect(s.list().map((t) => t.text)).toEqual(["Three", "Two"]);
    expect(calls).toBe(6);
    expect(TOAST_MS.danger).toBeGreaterThan(TOAST_MS.success);
  });

  it("outside a provider every call is silent", () => {
    function Probe() { const t = useToast(); t.success("x"); return h("p", null, "ok"); }
    expect(renderToStaticMarkup(h(Probe))).toBe("<p>ok</p>");
  });

  it("the app layout mounts one provider on each branch, in the page's language", () => {
    const layout = read("src/app/[lang]/app/layout.tsx");
    expect(layout.match(/<ToastProvider lang=\{lang\}>/g)).toHaveLength(2);
    const toast = read("src/components/ui/Toast.tsx");
    expect(toast).toMatch(/<div role="status" aria-live="polite">/);
    // The server snapshot is one shared empty list; a new array per call makes React loop ("getServerSnapshot should be cached").
    expect(toast).toMatch(/useSyncExternalStore\(store\.subscribe, store\.list, serverList\)/);
    expect(toast).toMatch(/const NONE: ToastItem\[\] = \[\];\nconst serverList = \(\) => NONE;/);
  });
});

describe("rule 1089: Dialog, FormDialog and usePrompt replace the browser's boxes and hand-made overlays", () => {
  it("promptGate asks one question at a time and counts the first answer", async () => {
    const g = promptGate();
    const shown: number[] = [];
    const first = g.ask((n) => shown.push(n));
    const second = await g.ask((n) => shown.push(n));
    expect(second).toBeNull();
    g.answer("Name");
    g.answer("Other");
    expect(await first).toBe("Name");
    expect(shown).toEqual([1]);
  });

  it("the dialog is a native modal that gives focus back and puts its close button last", () => {
    const src = read("src/components/ui/Dialog.tsx");
    expect(src).toMatch(/d\.showModal\(\)/);
    expect(src).toMatch(/opener\.focus\(\)/);
    expect(src.indexOf("{children}</div>")).toBeLessThan(src.indexOf("aria-label={CLOSE[lang]}"));
  });

  it("integrations asks before disconnecting and has no hand-made overlay; brands never call window.prompt", () => {
    const ip = read("src/components/app/IntegrationsPanel.tsx");
    expect(ip).toMatch(/const ok = await ask\(\{[\s\S]*?destructive: true,[\s\S]*?\}\);\n\s*if \(!ok\) return;/);
    expect(ip).not.toMatch(/fixed inset-0/);
    expect(ip.match(/<FormDialog /g)).toHaveLength(2);
    expect(read("src/components/app/BrandsPanel.tsx")).not.toMatch(/(?<![\w.])(?:window\.)?prompt\(/);
  });
});

describe("rule 1090: every auth field has a visible label", () => {
  it("each input of sign-up, sign-in, forgot and reset sits in a Field", () => {
    const src = read("src/components/app/AuthForm.tsx");
    expect(src.match(/<Field label=\{/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(src).not.toMatch(/<input\b/);
    expect(src).toMatch(/<Callout tone="danger">/);
  });
});

describe("rule 1091: the brands panel never shows a route's code", () => {
  it("an unknown refusal is a sentence in the page's language", () => {
    const src = read("src/components/app/BrandsPanel.tsx");
    expect(src).not.toMatch(/:\s*j\.error,/);
    expect(src).toContain('"لم يتم التغيير. حاول مرة أخرى."');
    expect(src).toContain('"Nothing changed. Try again."');
  });

  it("the integrations key dialog says verify failed, never the provider's raw reply", () => {
    const src = read("src/components/app/IntegrationsPanel.tsx");
    expect(src).not.toMatch(/j\.detail/);
    expect(src).toMatch(/j\.error === "verify_failed" \? g\.verifyFailed : connectError\(lang, j\.error\)/);
  });
});

describe("rules 1092-1094: dates, money and plurals", () => {
  it("formatTime writes Western digits in both languages and reads a bare day in UTC", () => {
    const ar = formatTime("2026-10-05", "ar");
    expect(ar).toMatch(/2026/);
    expect(ar).toMatch(/5/);
    expect(ar).not.toMatch(ARABIC_DIGITS);
    expect(formatTime("2026-10-05", "en")).toBe("Oct 5, 2026");
    // 23:30 UTC is already the next day in Riyadh.
    expect(formatTime("2026-10-05T23:30:00Z", "en")).toBe("Oct 6, 2026");
    expect(BRAND_TZ).toBe("Asia/Riyadh");
    expect(formatTime("not a date", "en")).toBe("");
    expect(formatTime(undefined, "ar")).toBe("");
    expect(isoFor("2026-10-05")).toBe("2026-10-05");
  });

  it("Time renders a <time> with the machine form; nothing for a missing value", () => {
    expect(renderToStaticMarkup(h(Time, { value: "2026-10-05", lang: "en" }))).toBe('<time dateTime="2026-10-05">Oct 5, 2026</time>');
    expect(renderToStaticMarkup(h(Time, { value: null, lang: "en" }))).toBe("");
  });

  it("money keeps Western digits and SAR, whole amounts without decimals", () => {
    const ar = formatMoney(299, "ar");
    expect(ar).toMatch(/299/);
    expect(ar).not.toMatch(ARABIC_DIGITS);
    expect(formatMoney(299, "en")).toMatch(/^SAR\s299$/);
    expect(formatMoney(0.35, "en")).toMatch(/0\.35/);
    expect(formatNumber(1500, "ar")).toBe("1,500");
    expect(renderToStaticMarkup(h(Money, { amount: 499, lang: "en" }))).toMatch(/^<bdi class="tnum">SAR\s499<\/bdi>$/);
  });

  it("plural picks the language's own form", () => {
    const days = { one: "يوم واحد", two: "يومان", few: "# أيام", many: "# يومًا", other: "# يوم" };
    expect(plural("ar", 1, days)).toBe("يوم واحد");
    expect(plural("ar", 2, days)).toBe("يومان");
    expect(plural("ar", 3, days)).toBe("3 أيام");
    expect(plural("ar", 11, days)).toBe("11 يومًا");
    expect(plural("ar", 100, days)).toBe("100 يوم");
    expect(plural("en", 1, { one: "# day", other: "# days" })).toBe("1 day");
    expect(plural("en", 2, { one: "# day", other: "# days" })).toBe("2 days");
    expect(plural("ar", 3, { other: "# x" })).toBe("3 x");
  });

  it("the trial strip counts with it (B-13) and is no longer lemon on a light ground", () => {
    const strip = (lang: "ar" | "en", days: number) => renderToStaticMarkup(h(TrialBanner, { lang, days, plan: "trial" }));
    expect(strip("ar", 2)).toContain("تجربتك تنتهي بعد يومين");
    expect(strip("ar", 5)).toContain("تجربتك تنتهي بعد 5 أيام");
    expect(strip("ar", 14)).toContain("تجربتك تنتهي بعد 14 يومًا");
    expect(strip("en", 1)).toContain("Your trial ends in 1 day");
    expect(strip("en", 1)).not.toMatch(/lemon/);
  });

  it("the migrated screens show dates through Time (no ISO cut in their JSX: the lint check below)", () => {
    expect(read("src/components/app/IntegrationsPanel.tsx")).toMatch(/<Time value=\{c\.connectedAt\} lang=\{lang\} \/>/);
    expect(read("src/components/app/BrandsPanel.tsx")).toMatch(/<Time value=\{b\.createdAt\} lang=\{lang\} \/>/);
    expect(read("src/components/app/settings/CreditUsageCard.tsx")).toMatch(/<Time value=\{p\.expiresAt\} lang=\{lang\} className="tnum" \/>/);
  });
});

describe("rule 1099: the screens moved onto the primitives", () => {
  it("brand form: labelled fields, a toast when saved, the error inline, pressed state on channel chips", () => {
    const src = read("src/components/app/BrandForm.tsx");
    expect(src.match(/<Field /g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(src).toMatch(/toast\.success\(o\.saved\)/);
    expect(src).toMatch(/\{err && <Callout tone="danger">\{err\}<\/Callout>\}/);
    expect(src).toMatch(/aria-pressed=\{channels\.includes\(c\)\}/);
    expect(src).toMatch(/<Button type="submit" loading=\{busy\}/);
  });

  it("brands list: rename in the app's own dialog, status as badges", () => {
    const src = read("src/components/app/BrandsPanel.tsx");
    expect(src).toMatch(/const \[ask, promptDialog\] = usePrompt\(lang\);/);
    expect(src).toMatch(/await ask\(\{ title:[^}]*maxLength: 80 \}\)/);
    expect(src).toMatch(/\{promptDialog\}/);
    expect(src).toMatch(/<Badge tone="inverse"/);
  });

  it("account deletion sits on Dialog as an alert dialog that waits while deleting", () => {
    const src = read("src/components/app/DeleteAccountDialog.tsx");
    expect(src).toMatch(/<Dialog lang=\{lang\} role="alertdialog"[^>]*blockClose=\{busy\}/);
    expect(src).toMatch(/<Button type="submit" variant="danger-solid"/);
  });

  it("integrations: notes are toasts, a refused disconnect is shown, badges never lemon", () => {
    const src = read("src/components/app/IntegrationsPanel.tsx");
    expect(src).not.toMatch(/setNote\(/);
    expect(src).toMatch(/toast\.success\(`\$\{g\.importProducts\}: \$\{j\.count\}`\)/);
    expect(src).toMatch(/if \(j\.ok\) setActErr\(""\); else fail\(j\.error\);/);
    expect(src).not.toMatch(/-lemon\b/);
    expect(src).toMatch(/<Badge tone=\{tone\(/);
  });
});

describe("rules 1095-1098: the UI lint warnings", () => {
  const linter = new Linter({ configType: "flat" });
  const lint = (code: string) => linter.verify(code, [{
    files: ["**/*.jsx"],
    plugins: { "thakeen-ui": thakeenUi },
    rules: warnings,
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  }], "x.jsx");
  const ids = (code: string) => lint(code).map((m) => m.ruleId);

  it("are warnings, registered for src", () => {
    expect(Object.values(warnings).every((v) => v === "warn")).toBe(true);
    const cfg = read("eslint.config.mjs");
    expect(cfg).toMatch(/files: \["src\/\*\*\/\*\.\{ts,tsx\}"\], plugins: \{ "thakeen-ui": thakeenUi \}, rules: thakeenUiWarnings/);
    expect(lint('const a = <p className="ml-2">x</p>;').every((m) => m.severity === 1)).toBe(true);
  });

  it("1095: red text is an alert or a destructive action", () => {
    expect(ids('const a = <p className="text-sm text-danger">x</p>;')).toEqual(["thakeen-ui/danger-text-needs-alert"]);
    expect(ids('const a = <p role="alert" className="text-danger">x</p>;')).toEqual([]);
    expect(ids('const a = <button className="text-danger">Delete</button>;')).toEqual([]);
    expect(ids('const a = <span className={ok ? "" : "text-danger"}>x</span>;')).toEqual(["thakeen-ui/danger-text-needs-alert"]);
  });

  it("1096: lemon only on ink", () => {
    expect(ids('const a = <div className="bg-lemon/40">x</div>;')).toEqual(["thakeen-ui/lemon-on-ink"]);
    expect(ids('const a = <div className="bg-ink"><span className="text-lemon">x</span></div>;')).toEqual([]);
    expect(ids('const a = <div data-surface="inverse"><i className="text-lemon" /></div>;')).toEqual([]);
    expect(ids('const a = <span className="bg-ink text-lemon">x</span>;')).toEqual([]);
  });

  it("1097: no ISO cut inside JSX; the same cut outside JSX is left alone", () => {
    expect(ids("const a = <p>{c.connectedAt.slice(0, 10)}</p>;")).toEqual(["thakeen-ui/no-date-slice"]);
    expect(ids("const a = <p>{list.map((x) => x.at.slice(0, 16))}</p>;")).toEqual(["thakeen-ui/no-date-slice"]);
    expect(ids("const day = at.slice(0, 10);")).toEqual([]);
    expect(ids("const a = <p>{name.slice(0, 3)}</p>;")).toEqual([]);
  });

  it("1098: physical sides, through variants and negatives, and the logical name in the message", () => {
    const m = lint('const a = <div className="sm:-ml-2 text-right pl-3 rounded-r-lg border-l-4">x</div>;');
    expect(m).toHaveLength(5);
    expect(m.map((x) => x.message.match(/use `([^`]+)`/)?.[1])).toEqual(["sm:-ms-2", "text-end", "ps-3", "rounded-e-lg", "border-s-4"]);
    expect(ids('const a = <div className="ms-2 pe-3 text-start border-lilac rounded-lg prose start-0">x</div>;')).toEqual([]);
    expect(baseOf("hover:!-mr-1")).toBe("mr-1");
    expect(PHYSICAL.test("right-0")).toBe(true);
  });

  it("the primitives and the migrated screens raise none of them", async () => {
    const tsParser = (await import("@typescript-eslint/parser")).default;
    const files = [
      "src/components/ui/Button.tsx", "src/components/ui/Field.tsx", "src/components/ui/Switch.tsx", "src/components/ui/Badge.tsx", "src/components/ui/Callout.tsx",
      "src/components/ui/Toast.tsx", "src/components/ui/Dialog.tsx", "src/components/ui/Time.tsx",
      "src/components/app/AuthForm.tsx", "src/components/app/BrandForm.tsx", "src/components/app/BrandsPanel.tsx", "src/components/app/DeleteAccountDialog.tsx",
      "src/components/app/settings/CreditUsageCard.tsx", "src/components/app/settings/AccountSettings.tsx", "src/components/app/settings/SecuritySettings.tsx", "src/components/app/IntegrationsPanel.tsx", "src/components/app/TrialBanner.tsx", "src/components/app/ReadOnlyNote.tsx",
      "src/components/app/GovernancePanel.tsx", "src/components/app/WorkingDaysPanel.tsx", "src/components/app/PasswordField.tsx",
    ];
    for (const f of files) {
      const found = linter.verify(read(f), [{ files: ["**/*.tsx"], plugins: { "thakeen-ui": thakeenUi }, rules: warnings, languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } } }], f);
      // Only this plugin is loaded, so a disable comment for a Next.js rule reports "rule not found": not ours to count.
      const ours = found.filter((m) => m.ruleId?.startsWith("thakeen-ui/") || m.fatal);
      expect(ours.map((m) => `${m.line}: ${m.ruleId ?? m.message}`), f).toEqual([]);
    }
  });
});
