import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Rules 2230-2232: the founder banner's «إنشاء حساب الموظف من جلسة المفتاح» link reaches the key form. Reported
 * 2026-10-18: the link went to /{lang}/admin?login=1, but that page showed the key form only to someone with no console
 * session at all, and the founder's customer session (rule 1649) counts as one, so the overview rendered again and the
 * founder never got the key session that creating the first staff login needs (rule 1639).
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/ar/admin",
  useSearchParams: () => new URLSearchParams(),
}));

import { showKeyForm } from "@/lib/admin-gate";
import { adminSignIn, newUser, signIn, signOut } from "./helpers/session";
import AdminLayout from "@/app/[lang]/admin/layout";
import AdminHome from "@/app/[lang]/admin/page";
import AdminLogin from "@/components/app/AdminLogin";
import { CB } from "@/components/admin/ConsoleBanners";

const KEY = "test-admin-key-staff-login-key-form";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });

const P = (l: string) => Promise.resolve({ lang: l });
const Q = (o: Record<string, string>) => Promise.resolve(o);
const layoutHtml = async (lang: "ar" | "en") => renderToStaticMarkup((await AdminLayout({ children: null, params: P(lang) })) as ReactElement);

async function founder() {
  const u = await newUser("founder-keyform");
  vi.stubEnv("ADMIN_EMAILS", u.email);
  await signIn(u.email);
  return u;
}

describe("the key form at ?login=1 (rules 2230-2232)", () => {
  it("shows for no session and for the founder's customer session, never for a staff or key session (rule 2230)", () => {
    const none = { staff: null, keySession: false };
    expect(showKeyForm("1", none)).toBe(true);
    expect(showKeyForm("1", { ...none, founder: true } as never), "the founder's customer session is not a key session").toBe(true);
    expect(showKeyForm("1", { staff: { email: "s@staff.example" }, keySession: false })).toBe(false);
    expect(showKeyForm("1", { staff: null, keySession: true })).toBe(false);
    expect(showKeyForm(undefined, none)).toBe(false);
    expect(showKeyForm("0", none)).toBe(false);
  });

  it("the founder banner links to ?login=1 while no owner exists, and that page now renders the key form (rule 2231)", async () => {
    await founder();
    for (const lang of ["ar", "en"] as const) {
      const shell = await layoutHtml(lang);
      expect(shell).toContain(CB[lang].founderBanner);
      expect(shell).toContain(`href="/${lang}/admin?login=1"`);
      expect(shell).toContain(CB[lang].toKey);
      const page = (await AdminHome({ params: P(lang), searchParams: Q({ login: "1" }) })) as ReactElement;
      expect(page.type, "the founder's link must not loop back to the overview").toBe(AdminLogin);
      expect(renderToStaticMarkup(page)).toMatch(/type="password"/);
    }
    // Without ?login=1 the founder still lands on the overview, not the form.
    const home = (await AdminHome({ params: P("ar"), searchParams: Q({}) })) as ReactElement;
    expect(home.type).not.toBe(AdminLogin);
  });

  it("once the key session is open the same URL shows the console with the create-staff-login button (rules 1639, 2232)", async () => {
    await founder();
    await adminSignIn();
    const page = (await AdminHome({ params: P("ar"), searchParams: Q({ login: "1" }) })) as ReactElement;
    expect(page.type, "a key session is never shown the form again").not.toBe(AdminLogin);
    const shell = await layoutHtml("ar");
    expect(shell).toContain(CB.ar.keyBanner);
    expect(shell).toContain(CB.ar.createNote);
    expect(shell).toContain(`>${CB.ar.create}<`);
    expect(shell).not.toContain(CB.ar.founderBanner);
  });

  it("the page no longer gates the form on any console session (rule 2230)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/[lang]/admin/page.tsx", "utf8");
    expect(src).toContain("showKeyForm(");
    expect(src).not.toContain("isAdminCookie");
  });
});
