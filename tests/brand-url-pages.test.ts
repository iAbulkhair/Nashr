import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { newUser, seedActiveBrand, signIn, signOut, withHeaders } from "./helpers/session";
import { acct, type User } from "@/lib/auth";
import { BRAND_HEADER, BRAND_SECTIONS, isBrandPath } from "@/lib/brand-path";
import { saveBrands, type BrandMeta } from "@/lib/brands";
import { LEGACY_SETTINGS, SETTINGS_SECTIONS, legacySettingsPath, settingsHref } from "@/lib/settings-nav";

/**
 * Rules 885 and 891 (brand id in the URL, Part C; plan docs/superpowers/plans/2026-10-20-brand-url.md Task 4, R-C5,
 * R-C6, R-C10). Every brand page lives under `/{lang}/app/b/[brand]`, its layout refuses a path brand that is not the
 * one `currentUser()` resolved, `/{lang}/app` goes to the last chosen brand, and an old brand path answers a 307 to the
 * brand path with its query, from the `[...legacy]` page.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

const APP = "src/app/[lang]/app";
const BRAND_DIR = `${APP}/b/[brand]`;
const NOT_FOUND = { digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) };
const T0 = "2026-10-01T00:00:00.000Z";

/** The target of a `redirect()` thrown by a server component, and its status. */
async function redirected(p: Promise<unknown>): Promise<{ url: URL; status: string }> {
  const err = (await p.then(() => { throw new Error("no redirect"); }, (e: unknown) => e)) as { digest?: string };
  const m = /^NEXT_REDIRECT;[a-z]+;(.+);(\d{3});/.exec(err?.digest ?? "");
  if (!m) throw err;
  return { url: new URL(m[1], "https://thakeen.test"), status: m[2] };
}

/** An owner with active b1, b2, whose last chosen brand is b2. */
async function ownerOnB2(prefix: string): Promise<User> {
  const owner = await newUser(prefix);
  const rows: BrandMeta[] = ["b1", "b2"].map((id) => ({ id, name: id, createdAt: T0, status: "active" as const }));
  await saveBrands(acct(owner), rows);
  await seedActiveBrand(owner.email, "b2");
  await signIn(owner.email);
  return owner;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const pageFile = (section: string, root: string) => (section === "" ? `${root}/page.tsx` : `${root}/${section}/page.tsx`);

describe("rule 885: brand pages live under /{lang}/app/b/[brand], account pages stay put", () => {
  it("the to-do page's route brand is required in its params type (fix round item 20)", () => {
    expect(readFileSync(`${BRAND_DIR}/todo/page.tsx`, "utf8")).toMatch(/params: Promise<\{ lang: string; brand: string \}>/);
  });

  it("BRAND_SECTIONS holds the four brand settings sections (R-C6, R-C10)", () => {
    for (const s of ["settings/brand", "settings/connections", "settings/governance", "settings/notifications"]) expect(BRAND_SECTIONS, s).toContain(s);
  });

  it("a page exists under b/[brand] for every brand section, none at the old path", () => {
    for (const s of BRAND_SECTIONS) {
      expect(existsSync(pageFile(s, BRAND_DIR)), s).toBe(true);
      // The inbox's old file is now the /app redirect (R-C5); every other old page is gone.
      if (s !== "") expect(existsSync(pageFile(s, APP)), s).toBe(false);
    }
    expect(existsSync(`${BRAND_DIR}/layout.tsx`)).toBe(true);
    expect(existsSync(`${BRAND_DIR}/settings/layout.tsx`)).toBe(true);
    expect(existsSync(`${APP}/[...legacy]/page.tsx`)).toBe(true);
  });

  it("no page, layout or loading file left outside b/ reads brand data through sc(", () => {
    const files = walk(APP).filter((f) => {
      const r = relative(APP, f).split(sep);
      if (r[0] === "b" || r[0] === "admin") return false;
      // The app shell's layout reads the brand name and the approvals badge for the rail (Task 6 makes it path-aware).
      if (r.length === 1 && r[0] === "layout.tsx") return false;
      return /\.(tsx|ts)$/.test(f);
    });
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bsc\(/);
  });

  it("every settings section has one page: the brand ones under b/[brand]/settings, the others under /settings", () => {
    for (const s of SETTINGS_SECTIONS) {
      const brand = isBrandPath(`/settings/${s}`);
      expect(existsSync(`${BRAND_DIR}/settings/${s}/page.tsx`), s).toBe(brand);
      expect(existsSync(`${APP}/settings/${s}/page.tsx`), s).toBe(!brand);
    }
  });

  it("both settings layouts render the one shared frame", () => {
    for (const f of [`${APP}/settings/layout.tsx`, `${BRAND_DIR}/settings/layout.tsx`]) expect(readFileSync(f, "utf8"), f).toMatch(/<SettingsFrame lang=\{lang\}/);
    expect(readFileSync(`${BRAND_DIR}/settings/layout.tsx`, "utf8")).toMatch(/<SettingsFrame lang=\{lang\} brand=\{brand\}/);
  });

  it("settingsHref puts a brand section under the brand when it has one; account sections never", () => {
    expect(settingsHref("ar")).toBe("/ar/app/settings");
    expect(settingsHref("en", "billing", "b2")).toBe("/en/app/settings/billing");
    expect(settingsHref("en", "brand", "b2")).toBe("/en/app/b/b2/settings/brand");
    expect(settingsHref("ar", "notifications", "b2")).toBe("/ar/app/b/b2/settings/notifications");
    // No brand known yet: the old path, which the [...legacy] page sends on.
    expect(settingsHref("ar", "connections")).toBe("/ar/app/settings/connections");
  });

  it("the proxy keeps the account settings renames and leaves the three that became brand sections to [...legacy]", () => {
    expect(legacySettingsPath("/ar/app/profile")).toBe("/ar/app/settings/account");
    expect(legacySettingsPath("/en/app/billing")).toBe("/en/app/settings/billing");
    for (const p of ["/en/app/onboarding", "/en/app/integrations", "/ar/app/governance"]) expect(legacySettingsPath(p), p).toBeNull();
    expect(Object.keys(LEGACY_SETTINGS)).toEqual(expect.arrayContaining(["onboarding", "integrations", "governance"]));
  });

  it("Next's route order sends old app paths to [...legacy], not to the language catch-all, and brand paths to b/[brand]", () => {
    // The same ordering Next uses to match a request to an app route (static, then [x], then [...x] at each level).
    const routes = walk("src/app")
      .filter((f) => /[/\\]page\.(tsx|ts|jsx|js)$/.test(f))
      .map((f) => "/" + relative("src/app", f).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/"))
      .map((r) => (r === "/" ? "/" : r.replace(/\/$/, "")));
    const sorted = getSortedRoutes(routes);
    const match = (url: string) => sorted.find((r) => getRouteRegex(r).re.test(url));
    expect(match("/ar/app/tasks")).toBe("/[lang]/app/[...legacy]");
    expect(match("/ar/app/settings/brand")).toBe("/[lang]/app/[...legacy]");
    expect(match("/ar/app/onboarding")).toBe("/[lang]/app/[...legacy]");
    expect(match("/ar/app/b/b2/tasks")).toBe("/[lang]/app/b/[brand]/tasks");
    expect(match("/ar/app/b/b2")).toBe("/[lang]/app/b/[brand]");
    expect(match("/ar/app/b/b2/settings/brand")).toBe("/[lang]/app/b/[brand]/settings/brand");
    expect(match("/ar/app/settings/billing")).toBe("/[lang]/app/settings/billing");
    expect(match("/ar/app")).toBe("/[lang]/app");
    expect(match("/ar/app/login")).toBe("/[lang]/app/login");
    expect(match("/ar/pricing-nope")).toBe("/[lang]/[...rest]");
  });
});

describe("rule 891: /app goes to the last chosen brand, the b/[brand] layout holds the path to it, old paths 307", () => {
  it("/{lang}/app redirects to /{lang}/app/b/{u.brandId}; signed out, to login", async () => {
    const { default: AppIndex } = await import("@/app/[lang]/app/page");
    await ownerOnB2("bi");
    const r = await redirected(AppIndex({ params: Promise.resolve({ lang: "ar" }) }));
    expect(r.url.pathname + r.url.search).toBe("/ar/app/b/b2");
    signOut();
    expect((await redirected(AppIndex({ params: Promise.resolve({ lang: "en" }) }))).url.pathname).toBe("/en/app/login");
  });

  it("the brand layout renders when the path's brand is the one resolved, and 404s when it is not", async () => {
    const { default: BrandLayout } = await import("@/app/[lang]/app/b/[brand]/layout");
    await ownerOnB2("bl");
    const kid = "child";
    // The proxy set the header from the path: the path brand and u.brandId agree.
    const ok = await withHeaders({ [BRAND_HEADER]: "b1" }, () => BrandLayout({ children: kid, params: Promise.resolve({ lang: "ar", brand: "b1" }) }));
    expect(JSON.stringify(ok)).toContain(kid);
    // A path brand that is not the resolved one (no header reached the server: the session's last choice is b2).
    await expect(BrandLayout({ children: kid, params: Promise.resolve({ lang: "ar", brand: "b1" }) })).rejects.toMatchObject(NOT_FOUND);
    await expect(withHeaders({ [BRAND_HEADER]: "b2" }, () => BrandLayout({ children: kid, params: Promise.resolve({ lang: "ar", brand: "b1" }) }))).rejects.toMatchObject(NOT_FOUND);
    // Another account's or an unknown brand: currentUser() itself is the 404 (rule 886).
    await expect(withHeaders({ [BRAND_HEADER]: "zz99zz99" }, () => BrandLayout({ children: kid, params: Promise.resolve({ lang: "ar", brand: "zz99zz99" }) }))).rejects.toMatchObject(NOT_FOUND);
    await expect(withHeaders({ [BRAND_HEADER]: "b1" }, () => BrandLayout({ children: kid, params: Promise.resolve({ lang: "xx", brand: "b1" }) }))).rejects.toMatchObject(NOT_FOUND);
  });

  it("an old brand path answers 307 to the brand path, with its query rebuilt", async () => {
    const { default: Legacy } = await import("@/app/[lang]/app/[...legacy]/page");
    await ownerOnB2("lg");
    const go = (lang: string, legacy: string[], sp: Record<string, string | string[] | undefined> = {}) =>
      redirected(Legacy({ params: Promise.resolve({ lang, legacy }), searchParams: Promise.resolve(sp) }));

    const t = await go("ar", ["tasks"], { id: "1", x: "a b", tag: ["p", "q"], none: undefined });
    expect(t.status).toBe("307");
    expect(t.url.pathname).toBe("/ar/app/b/b2/tasks");
    expect(t.url.searchParams.get("id")).toBe("1");
    expect(t.url.searchParams.get("x")).toBe("a b");
    expect(t.url.searchParams.getAll("tag")).toEqual(["p", "q"]);
    expect(t.url.searchParams.has("none")).toBe(false);

    expect((await go("en", ["settings", "brand"])).url.pathname).toBe("/en/app/b/b2/settings/brand");
    expect((await go("en", ["settings", "notifications"])).url.pathname).toBe("/en/app/b/b2/settings/notifications");
    expect((await go("ar", ["onboarding"])).url.pathname).toBe("/ar/app/b/b2/settings/brand");
    const integ = await go("ar", ["integrations"], { error: "denied" });
    expect(integ.url.pathname + integ.url.search).toBe("/ar/app/b/b2/settings/connections?error=denied");
    expect((await go("ar", ["governance"])).url.pathname).toBe("/ar/app/b/b2/settings/governance");
    const chat = await go("ar", ["chat"], { conv: "c1" });
    expect(chat.url.pathname).toBe("/ar/app/b/b2/chat");
    expect([...chat.url.searchParams]).toEqual([["conv", "c1"]]);
    expect((await go("ar", ["todo", "x"])).url.pathname).toBe("/ar/app/b/b2/todo/x");
  });

  it("anything else is a 404; a segment cannot smuggle a query or leave the app", async () => {
    const { default: Legacy } = await import("@/app/[lang]/app/[...legacy]/page");
    await ownerOnB2("lx");
    const run = (lang: string, legacy: string[]) => Legacy({ params: Promise.resolve({ lang, legacy }), searchParams: Promise.resolve({}) });
    for (const legacy of [["nope"], ["b"], ["b", "b2", "nope"], ["settings"], ["settings", "nope"], ["tasks?x=1"], ["chatter"]]) {
      await expect(run("ar", legacy), legacy.join("/")).rejects.toMatchObject(NOT_FOUND);
    }
    await expect(run("xx", ["tasks"])).rejects.toMatchObject(NOT_FOUND);
  });

  it('an empty, "." or ".." segment is a 404, never a redirect that walks out of its section (fix round item 12)', async () => {
    const { default: Legacy } = await import("@/app/[lang]/app/[...legacy]/page");
    await ownerOnB2("ld");
    const run = (legacy: string[]) => Legacy({ params: Promise.resolve({ lang: "ar", legacy }), searchParams: Promise.resolve({}) });
    for (const legacy of [["tasks", ".."], ["tasks", "."], ["tasks", ""], ["..", "tasks"], [".", "chat"], ["", "tasks"], ["settings", "..", "brand"], ["files", "x", ".."]]) {
      await expect(run(legacy), JSON.stringify(legacy)).rejects.toMatchObject(NOT_FOUND);
    }
    // A segment that only contains dots among other characters is an ordinary record id.
    expect((await redirected(run(["files", "a..b"]))).url.pathname).toBe("/ar/app/b/b2/files/a..b");
  });

  it("signed out, an old brand path goes to login", async () => {
    const { default: Legacy } = await import("@/app/[lang]/app/[...legacy]/page");
    const r = await redirected(Legacy({ params: Promise.resolve({ lang: "ar", legacy: ["tasks"] }), searchParams: Promise.resolve({ id: "1" }) }));
    expect(r.url.pathname).toBe("/ar/app/login");
  });
});
