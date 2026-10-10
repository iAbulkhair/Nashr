import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { existsSync, readFileSync } from "node:fs";

/**
 * The founder console lives in its own route tree, /{lang}/admin, with its own layout and sidebar (spec
 * docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md part A). Rules 870-874.
 */

// AdminNav reads the router; outside Next there is none. Server-only helpers (redirect, notFound) stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/ar/admin/users",
  useSearchParams: () => new URLSearchParams(),
}));

import { ADMIN_SECTIONS, adminHref, type AdminSection } from "@/lib/admin-gate";
import { adminSignIn, newUser, signIn, signOut } from "./helpers/session";
import AdminLayout from "@/app/[lang]/admin/layout";
import AdminHome from "@/app/[lang]/admin/page";
import OldAdmin from "@/app/[lang]/app/admin/page";
import Sidebar from "@/components/app/Sidebar";
import { appDict } from "@/lib/app-i18n";

const KEY = "test-admin-key-admin-shell";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });

const P = (l: string) => Promise.resolve({ lang: l });
const Q = (o: Record<string, string>) => Promise.resolve(o);
type Page = (p: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const PAGES: Record<AdminSection, () => Promise<{ default: unknown }>> = {
  overview: async () => ({ default: AdminHome }),
  users: () => import("@/app/[lang]/admin/users/page"),
  leads: () => import("@/app/[lang]/admin/leads/page"),
  usage: () => import("@/app/[lang]/admin/usage/page"),
  billing: () => import("@/app/[lang]/admin/billing/page"),
  partners: () => import("@/app/[lang]/admin/partners/page"),
  quality: () => import("@/app/[lang]/admin/quality/page"),
  skills: () => import("@/app/[lang]/admin/skills/page"),
  wishlist: () => import("@/app/[lang]/admin/wishlist/page"),
  log: () => import("@/app/[lang]/admin/log/page"),
};
const pageFor = async (s: AdminSection): Promise<Page> => (await PAGES[s]()).default as Page;

describe("the founder console has its own shell (rules 870-872)", () => {
  it("every /{lang}/admin page is a 404 without the gate (rule 870)", async () => {
    for (const s of ADMIN_SECTIONS) await expect((await pageFor(s))({ params: P("en"), searchParams: Q({}) }), s).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("with a key session the layout renders the founder shell and never the customer Sidebar (rule 871)", async () => {
    await adminSignIn();
    const html = renderToStaticMarkup((await AdminLayout({ children: null, params: P("ar") })) as React.ReactElement);
    expect(html).toContain("لوحة المؤسس");
    expect(html).toContain('href="/ar/admin/log"');
    expect(html).not.toContain('data-testid="app-sidebar"');
    expect(html).toContain("إنهاء جلسة المفتاح");
    expect(html).not.toContain("العودة للتطبيق"); // key session only: no founder sign-in to go back to
  });

  it("a founder signed in as themselves gets «العودة للتطبيق» and no end-key button without a key session", async () => {
    const u = await newUser("founder-shell");
    vi.stubEnv("ADMIN_EMAILS", u.email);
    await signIn(u.email);
    const html = renderToStaticMarkup((await AdminLayout({ children: null, params: P("ar") })) as React.ReactElement);
    expect(html).toContain("العودة للتطبيق");
    expect(html).toContain('href="/ar/app"');
    expect(html).not.toContain("إنهاء جلسة المفتاح");
    await adminSignIn();
    const both = renderToStaticMarkup((await AdminLayout({ children: null, params: P("ar") })) as React.ReactElement);
    expect(both).toContain("العودة للتطبيق");
    expect(both).toContain("إنهاء جلسة المفتاح");
  });

  it("without the gate the layout is bare and ?login=1 renders only the key form (rule 870)", async () => {
    const shell = renderToStaticMarkup((await AdminLayout({ children: null, params: P("en") })) as React.ReactElement);
    expect(shell).not.toContain('href="/en/admin/log"');
    const html = renderToStaticMarkup((await AdminHome({ params: P("en"), searchParams: Q({ login: "1" }) })) as React.ReactElement);
    expect(html).toMatch(/type="password"/);
    expect(html).not.toContain('href="/en/admin/log"'); // the key form has its own title; no console sidebar
  });

  it("/{lang}/app/admin redirects to /{lang}/admin with the query kept (rule 872)", async () => {
    await expect(OldAdmin({ params: P("en"), searchParams: Q({ login: "1" }) })).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/en\/admin\?login=1;/) });
    await expect(OldAdmin({ params: P("ar"), searchParams: Q({}) })).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/ar\/admin;/) });
  });

  it("the ended link and the impersonation return point into /{lang}/admin (rule 872)", async () => {
    const { adminEndedHref } = await import("@/lib/admin-fetch");
    expect(adminEndedHref("ar", true)).toBe("/ar/admin?login=1");
    expect(adminEndedHref("ar", false)).toBe("/ar/app/login");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/admin/impersonate/route.ts", "utf8")).toContain("`/${lang}/admin/users`");
  });

  it("adminHref", () => {
    expect(adminHref("ar", "overview")).toBe("/ar/admin");
    expect(adminHref("en", "log")).toBe("/en/admin/log");
  });
});

describe("the customer app links to the console only from the account menu (rule 873)", () => {
  it("no founder row in the customer main nav; the account menu links to /{lang}/admin as «لوحة الأدمن»", () => {
    const html = (admin: boolean) => renderToStaticMarkup(createElement(Sidebar, { t: appDict.ar, lang: "ar", user: { name: "F", email: "f@test.example", role: "owner", credits: 10, plan: "pro" }, show: { owner: true, refer: true, mcp: true }, admin }));
    expect(html(true)).not.toContain('href="/ar/app/admin"');
    expect(html(true)).not.toContain("/ar/admin");
    expect(html(false)).not.toContain("/ar/admin");
    // The account menu renders only when opened, so its link is pinned in the source.
    expect(readFileSync("src/components/app/Sidebar.tsx", "utf8")).toMatch(/admin \? \[\[adminHref\(lang, "overview"\), N\.adminPanel\]\]/);
    expect([appDict.ar.nav.adminPanel, appDict.en.nav.adminPanel]).toEqual(["لوحة الأدمن", "Admin console"]);
  });
});

describe("one component per console section (rule 874)", () => {
  it("each section fetches only its own endpoints and AdminConsole is gone (rule 874)", () => {
    expect(existsSync("src/components/app/AdminConsole.tsx")).toBe(false);
    const src = (f: string) => readFileSync(`src/components/admin/${f}.tsx`, "utf8");
    expect(src("Log")).toMatch(/\/api\/admin\/log/);
    expect(src("Log")).not.toMatch(/\/api\/admin\/(plan|overview|evals)/);
    expect(src("Quality")).not.toMatch(/\/api\/admin\/plan/);
    for (const f of ["Overview", "Users", "Usage", "Billing", "Quality", "Log"]) expect(src(f)).toMatch(/useAdminEnded\(\)/);
  });

  it("with a key session every section page renders its own component (rule 874)", async () => {
    await adminSignIn();
    const marks: Record<AdminSection, RegExp> = { overview: /…/, users: /type="text"|placeholder=/, leads: /data-testid="leads-panel"/, usage: /Loading…|جارٍ التحميل…/, billing: /Loading…|جارٍ التحميل…/, partners: /^<p class="text-sm text-muted">Loading…<\/p>$/, quality: /Agent quality/, skills: /Agent skills/, wishlist: /^<p class="text-sm text-muted">Loading…<\/p>$/, log: /Every founder action/ };
    for (const s of ADMIN_SECTIONS) {
      const html = renderToStaticMarkup((await (await pageFor(s))({ params: P("en"), searchParams: Q({}) })) as React.ReactElement);
      expect(html, s).toMatch(marks[s]);
      expect(html, s).not.toContain('role="alert"');
    }
  });

  it("a signed-in customer who is not a founder gets a 404 on every section (rule 870)", async () => {
    const u = await newUser("not-founder");
    await signIn(u.email);
    for (const s of ADMIN_SECTIONS) await expect((await pageFor(s))({ params: P("en"), searchParams: Q({}) }), s).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("a key session that ended mid-use shows the ended notice on the next section, not a 404 (rule 870, final review)", async () => {
    await adminSignIn();
    vi.stubEnv("WAITLIST_ADMIN_KEY", "another-key-the-old-session-does-not-match");
    for (const s of ADMIN_SECTIONS) {
      const html = renderToStaticMarkup((await (await pageFor(s))({ params: P("en"), searchParams: Q({}) })) as React.ReactElement);
      expect(html, s).toContain('role="alert"');
      expect(html, s).toContain('href="/en/admin?login=1"');
    }
  });

  it("the console's wide tables scroll inside themselves at 375 px, and the console is never indexed (final review)", async () => {
    for (const f of ["Overview", "Usage", "Quality", "Log"]) {
      const src = readFileSync(`src/components/admin/${f}.tsx`, "utf8");
      expect(src.match(/<table/g)?.length, f).toBe(src.match(/<div className="overflow-x-auto">\s*<table/g)?.length);
    }
    const { metadata } = await import("@/app/[lang]/admin/layout");
    expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
  });

  it("Usage and Billing read only the overview, never the user list, the evals or the log (rule 874)", () => {
    for (const f of ["Usage", "Billing"]) expect(readFileSync(`src/components/admin/${f}.tsx`, "utf8"), f).not.toMatch(/\/api\/admin\/(plan|evals|log)/);
  });
});
