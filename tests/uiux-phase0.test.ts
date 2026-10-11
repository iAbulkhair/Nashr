// UI/UX phase 0 (docs/reports/2026-10-10-supastarter-uiux-report.md §3 and §7): the bugs B-1 to B-11 and the quick wins.
// Source-reading checks (no DOM in this suite) plus the pure helpers driven directly.
import { describe, expect, it } from "vitest";
import { existsSync, globSync, readFileSync } from "node:fs";
import { parseTrialDays, TRIAL_EXTEND_MAX_DAYS } from "@/lib/admin-input";
import { APP_SCREENS, APP_SCREEN_NAME, appScreenMeta, adminScreenMeta, screenTitle, SKIP_TO_CONTENT } from "@/lib/screen-titles";
import { ADMIN_LABEL, ADMIN_SECTIONS } from "@/lib/admin-gate";
import { emailMatches, DELETE_ACCOUNT_TEXT } from "@/components/app/DeleteAccountDialog";
import { brandSaveError, BRAND_SAVE_ERRORS } from "@/components/app/BrandForm";
import { CONNECT_ERROR_CODES, CONNECT_ERRORS, connectError } from "@/lib/connect-errors";

const read = (f: string) => readFileSync(f, "utf8");
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;
// A call to the browser's prompt, alert or confirm, not `askReason(`, `.confirm(` on another object, a `prompt:` key or
// the name quoted in a comment (`alert()`).
const NATIVE = (name: string) => new RegExp(`(?<![\\w$.\`])(?:window\\.)?${name}\\(`);

describe("rule 960: founder console prompts stop on Cancel, the trial days are checked, the temporary password is shown once", () => {
  const users = read("src/components/admin/Users.tsx");

  it("never turns a cancelled reason into an empty one", () => {
    expect(users).not.toMatch(/prompt\(O\.reason, ""\) \?\? ""/);
    expect(users).toMatch(/const askReason = \(\): string \| null => prompt\(O\.reason, ""\);/);
  });

  it("stops each of the nine changes that ask a reason when it is cancelled", () => {
    // plan, seats, chat, deal, credits, top-up, void, refund: return on null; member removal: act only when not null.
    expect(count(users, /const reason = askReason\(\);\n\s*if \(reason === null\) return;/g)).toBe(8);
    expect(users).toMatch(/const reason = askReason\(\); if \(reason !== null\) void act\(/);
    expect(count(users, /askReason\(\)/g)).toBe(9);
  });

  it("extends a trial only by a whole number of days from 1 to 90", () => {
    expect(TRIAL_EXTEND_MAX_DAYS).toBe(90);
    expect(parseTrialDays(null)).toBeNull();
    for (const bad of ["", " ", "0", "-3", "7.5", "1e2", "abc", "91", "007a"]) expect(parseTrialDays(bad), bad).toBeNull();
    expect(parseTrialDays("1")).toBe(1);
    expect(parseTrialDays(" 14 ")).toBe(14);
    expect(parseTrialDays("90")).toBe(90);
    expect(users).not.toMatch(/Number\(prompt\(S\.promptDays/);
    expect(users).toMatch(/onClick=\{\(\) => extendTrial\(sel\.user\.email\)\}/);
    expect(read("src/app/api/admin/users/[email]/route.ts")).toMatch(/Math\.min\(TRIAL_EXTEND_MAX_DAYS,/);
  });

  it("shows the temporary password in the console's own read-only dialog, not in a prompt", () => {
    expect(users).toMatch(/setTemp\(\{ email, password: j\.tempPassword \}\)/);
    expect(users).not.toMatch(/prompt\([^)]*tempPassword/);
    expect(users).toMatch(/<TempPasswordDialog [^>]*onClose=\{\(\) => setTemp\(null\)\}/);
    const dlg = read("src/components/admin/TempPasswordDialog.tsx");
    expect(dlg).toMatch(/showModal\(\)/);
    expect(dlg).toMatch(/navigator\.clipboard\.writeText\(password\)/);
    expect(dlg).not.toMatch(/<input/);
  });
});

describe("rule 961: every app and founder console screen has its own title", () => {
  const pages = [...globSync("src/app/[[]lang[]]/app/**/page.tsx"), ...globSync("src/app/[[]lang[]]/admin/**/page.tsx")];

  it("finds all 40 pages and each exports generateMetadata from the shared helper", () => {
    expect(pages.length).toBe(40);
    for (const p of pages) expect(read(p), p).toMatch(/export const generateMetadata = (?:app|admin)ScreenMeta\("[a-z]+"\);/);
  });

  it("names each screen once per language, with the brand last", async () => {
    for (const lang of ["ar", "en"] as const) {
      const names = APP_SCREENS.map((s) => APP_SCREEN_NAME[lang][s]);
      expect(names.every((n) => n.trim().length > 0)).toBe(true);
      expect(new Set(names).size, lang).toBe(names.length);
      expect(new Set(ADMIN_SECTIONS.map((s) => ADMIN_LABEL[lang][s])).size).toBe(ADMIN_SECTIONS.length);
    }
    expect(screenTitle("ar", "التقارير")).toBe("التقارير · ذكين");
    const meta = await appScreenMeta("reports")({ params: Promise.resolve({ lang: "en" }) });
    expect(meta.title).toBe(`${APP_SCREEN_NAME.en.reports} · Thakeen`);
    expect(await appScreenMeta("reports")({ params: Promise.resolve({ lang: "fr" }) })).toEqual({});
    expect((await adminScreenMeta("users")({ params: Promise.resolve({ lang: "ar" }) })).title).toBe(`${ADMIN_LABEL.ar.users} · ذكين`);
  });

  it("uses the key each page's own route names", () => {
    for (const p of pages) {
      const seg = p.split("/").slice(-2, -1)[0];
      const key = read(p).match(/ScreenMeta\("([a-z]+)"\)/)?.[1];
      const want = seg === "app" ? "home" : seg === "admin" ? (p.includes("/app/admin/") ? "admin" : "overview") : seg;
      expect(key, p).toBe(want);
    }
  });
});

describe("rule 962: the chat panel is keyed by its thread", () => {
  const page = read("src/app/[lang]/app/chat/page.tsx");
  const panel = read("src/components/app/ChatPanel.tsx");

  it("mounts a new panel when the conversation or specialist in the address changes", () => {
    expect(page).toMatch(/<ChatPanel key=\{conv \?\? agentParam \?\? "default"\}/);
    expect(page).toMatch(/<ChatPanel key="default" /);
  });

  it("puts a new thread in the address, so a link back to the old one is a new key", () => {
    expect(panel).toMatch(/if \(!j\.ok\) return;\n\s*setConvs/);
    expect(panel).toMatch(/router\.replace\(`\/\$\{lang\}\/app\/chat\?conv=\$\{j\.conversation\.id\}/);
  });
});

describe("rule 963: the chat's messages are a live log", () => {
  const panel = read("src/components/app/ChatPanel.tsx");
  it("reads new messages to a screen reader and says while the answer is coming", () => {
    expect(panel).toMatch(/role="log" aria-live="polite" aria-label=\{A\[agent\]\.name\}/);
    expect(panel).toMatch(/<p role="status" className="sr-only">\{busy \?/);
    expect(panel).toMatch(/aria-busy=\{busy\}/);
  });
});

describe("rule 964: deleting the account asks in the app's own masked dialog", () => {
  const profile = read("src/components/app/ProfilePanel.tsx");
  const dlg = read("src/components/app/DeleteAccountDialog.tsx");

  it("has no browser prompt for the password", () => {
    expect(profile).not.toMatch(NATIVE("prompt"));
    expect(profile).toMatch(/<DeleteAccountDialog lang=\{lang\} email=\{me\.email\}/);
    expect(dlg).toMatch(/<PasswordField /);
    expect(dlg).toMatch(/role="alertdialog"/);
    expect(dlg).toMatch(/disabled=\{!ready\}/);
  });

  it("turns the delete button on only for the account's own email", () => {
    expect(emailMatches(" Owner@Example.com ", "owner@example.com")).toBe(true);
    expect(emailMatches("owner@example.co", "owner@example.com")).toBe(false);
    expect(emailMatches("", "owner@example.com")).toBe(false);
  });

  it("says what is lost in both languages", () => {
    expect(DELETE_ACCOUNT_TEXT.ar.lose.length).toBe(DELETE_ACCOUNT_TEXT.en.lose.length);
    expect(DELETE_ACCOUNT_TEXT.ar.lose.length).toBeGreaterThanOrEqual(3);
  });
});

describe("rule 965: the homepage's running text is in the body face", () => {
  it("puts --font-body first in --home-body", () => {
    expect(read("src/components/home/home.module.css")).toMatch(/--home-body: var\(--font-body\), /);
  });
});

describe("rules 966, 968, 969: one light colour scheme, a skip link and landmarks, no letter spacing on Arabic", () => {
  const globals = read("src/app/globals.css");
  it("declares color-scheme: light on html", () => {
    expect(globals).toMatch(/html \{[^}]*color-scheme: light;/);
  });
  it("opens the app and console shells with a skip link to <main id=\"main\">", () => {
    for (const f of ["src/app/[lang]/app/layout.tsx", "src/app/[lang]/admin/layout.tsx"]) {
      const src = read(f);
      expect(count(src, /<a href="#main" className="skip-link">\{SKIP_TO_CONTENT\[lang\]\}<\/a>/g), f).toBe(2);
      expect(count(src, /<main id="main" tabIndex=\{-1\}/g), f).toBe(2);
    }
    expect(SKIP_TO_CONTENT.ar).toBe("تخطَّ إلى المحتوى");
    expect(globals).toMatch(/\.skip-link:focus \{ top: 1rem; \}/);
  });
  it("marks the navigation as landmarks with the current page", () => {
    const side = read("src/components/app/Sidebar.tsx");
    expect(side).toMatch(/<nav aria-label=/);
    expect(side).toMatch(/aria-current=\{active\(href\) \? "page" : undefined\}/);
    expect(side).toMatch(/useSearchParams\(\)/);
    expect(read("src/components/admin/AdminNav.tsx")).toMatch(/<nav aria-label=/);
  });
  it("turns letter spacing and uppercase off for Arabic", () => {
    expect(globals).toMatch(/:lang\(ar\) \.eyebrow[^{]*\{ letter-spacing: 0; text-transform: none; \}/);
  });
});

describe("rule 967: chart series are readable on paper", () => {
  const globals = read("src/app/globals.css");
  it("defines four chart tokens without a lemon, lilac or raw light agent fill", () => {
    for (const n of [1, 2, 3, 4]) expect(globals).toMatch(new RegExp(`--chart-${n}: `));
    const block = globals.match(/--chart-1:[\s\S]*?--chart-4:[^;]*;/)?.[0] ?? "";
    expect(block).not.toMatch(/accent|lemon|lilac|inverse-muted|agent-noor/);
    expect(block).toMatch(/--chart-3: color-mix\(in oklab, var\(--color-agent-dana\) 55%, var\(--color-ink\)\)/);
  });
  it("draws the Reports and Overview lines from them, each with its own dash", () => {
    const reports = read("src/components/app/ReportsPanel.tsx");
    const overview = read("src/components/admin/Overview.tsx");
    expect(reports).toMatch(/created: "var\(--chart-1\)", approved: "var\(--chart-2\)", published: "var\(--chart-3\)"/);
    expect(overview).toMatch(/approve: "var\(--chart-4\)"/);
    for (const src of [reports, overview]) {
      expect(src).not.toMatch(/var\(--color-(?:accent|inverse-muted|danger)\)"/);
      expect(src).toMatch(/strokeDasharray=\{dashes\[/);
    }
  });
});

describe("rule 974: Paymob renewal off and card removal ask first", () => {
  const src = read("src/components/app/PaymobBilling.tsx");
  it("confirms cancel and remove_card in the app's own dialog, not resume", () => {
    expect(src).toMatch(/const \[ask, confirmDialog\] = useConfirm\(\);/);
    expect(src).toMatch(/if \(action !== "resume"\) \{/);
    expect(count(src, /destructive: true/g)).toBe(2);
    expect(src).toMatch(/\{confirmDialog\}/);
    expect(src).not.toMatch(NATIVE("confirm"));
  });
});

describe("rule 975: a brand save that fails says why", () => {
  const src = read("src/components/app/BrandForm.tsx");
  it("shows an alert on a refusal and stays on the form after a save of a brand that exists", () => {
    expect(src).toMatch(/if \(!res\?\.ok\) \{/);
    // The alert is the danger Callout now (rule 1087), which renders role="alert".
    expect(src).toMatch(/\{err && <Callout tone="danger">/);
    expect(src).toMatch(/if \(initial\) r\.refresh\(\);/);
  });
  it("maps the route's codes and statuses", () => {
    expect(brandSaveError("ar", 400, "missing")).toBe(BRAND_SAVE_ERRORS.ar.missing);
    expect(brandSaveError("en", 409, "busy")).toBe(BRAND_SAVE_ERRORS.en.busy);
    expect(brandSaveError("en", 403)).toBe(BRAND_SAVE_ERRORS.en.forbidden);
    expect(brandSaveError("ar", 0)).toBe(BRAND_SAVE_ERRORS.ar.failed);
  });
});

describe("rule 976: Connections never shows a raw error code", () => {
  const src = read("src/components/app/IntegrationsPanel.tsx");
  it("has no alert() and maps the address's ?error= through the message table", () => {
    expect(src).not.toMatch(NATIVE("alert"));
    expect(src).toMatch(/connectError\(lang, errorCode\)/);
    expect(src).not.toMatch(/sp\.get\("error"\)\}\)/);
    expect(src).toMatch(/<Callout tone="danger"[^>]*>\{actErr \|\| flashErr\}<\/Callout>/);
  });
  it("covers every code the connect routes answer, in both languages, with a generic fallback", () => {
    const routes = globSync("src/app/api/connect/**/route.ts").map(read).join("\n");
    const codes = new Set([...routes.matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]));
    for (const m of routes.matchAll(/[?&`"]error=([a-z_]+)/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(10);
    for (const c of codes) expect(CONNECT_ERROR_CODES as readonly string[], c).toContain(c);
    for (const lang of ["ar", "en"] as const) for (const c of CONNECT_ERROR_CODES) expect(CONNECT_ERRORS[lang][c].length, `${lang} ${c}`).toBeGreaterThan(0);
    expect(connectError("en", "verify_failed")).toBe(CONNECT_ERRORS.en.verify_failed);
    expect(connectError("ar", "Some provider said <b>no</b>")).toBe(CONNECT_ERRORS.ar.generic);
    expect(connectError("en", undefined)).toBe(CONNECT_ERRORS.en.generic);
  });
});

describe("rule 977: a screen that throws keeps its shell", () => {
  it("has an error boundary in the app and the console that retries", () => {
    for (const area of ["app", "admin"]) {
      const f = `src/app/[lang]/${area}/error.tsx`;
      expect(existsSync(f), f).toBe(true);
      expect(read(f)).toMatch(new RegExp(`<ShellError error=\\{error\\} retry=\\{retry\\} area="${area}" />`));
    }
    const shell = read("src/components/app/ShellError.tsx");
    expect(shell).toMatch(/onClick=\{\(\) => retry\(\)\}/);
    expect(shell).not.toMatch(/<main/);
  });
});
