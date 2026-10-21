import { test, expect, open, LANGS } from "./fixtures/app";
import { APP_ROUTES, APP_PUBLIC_ROUTES } from "./fixtures/routes";

test.describe("language routing", () => {
  test("/ sends an English browser to /en", async ({ page }) => {
    const res = await open(page, "/");
    expect(res.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/en");
  });

  test("the thakeen_lang cookie wins over Accept-Language", async ({ page, context }) => {
    await context.addCookies([{ name: "thakeen_lang", value: "ar", url: "http://localhost" }]);
    await open(page, "/");
    expect(new URL(page.url()).pathname).toBe("/ar");
  });

  // Expand release of the cookie rename (rule 1810): a browser that still holds only the old name keeps its language.
  test("the old nashr_lang cookie still wins over Accept-Language", async ({ page, context }) => {
    await context.addCookies([{ name: "nashr_lang", value: "ar", url: "http://localhost" }]);
    await open(page, "/");
    expect(new URL(page.url()).pathname).toBe("/ar");
  });

  test("an unknown language is a 404, not a redirect", async ({ page }) => {
    const res = await open(page, "/xx");
    expect(res.status()).toBe(404);
  });
});

test.describe("unauthenticated access to the app", () => {
  for (const lang of LANGS) {
    for (const route of APP_ROUTES) {
      test(`/${lang}${route.path} sends a signed-out visitor to the login page`, async ({ page }) => {
        const res = await open(page, `/${lang}${route.path}`);
        expect(res.status()).toBe(200);
        expect(new URL(page.url()).pathname, `${route.path} must not render for a signed-out visitor`).toBe(`/${lang}/app/login`);
      });
    }
  }

  // The verify page is in the layout's PUBLIC list so an owner who has not proved the address can reach it, but with no
  // session at all it goes to login (rule 754).
  for (const lang of LANGS) {
    test(`/${lang}/app/verify sends a signed-out visitor to the login page`, async ({ page }) => {
      const res = await open(page, `/${lang}/app/verify`);
      expect(res.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/${lang}/app/login`);
    });
  }

  for (const lang of LANGS) {
    for (const path of APP_PUBLIC_ROUTES.filter((p) => p !== "/app/admin")) {
      test(`/${lang}${path} is reachable signed out`, async ({ page }) => {
        const res = await open(page, `/${lang}${path}`);
        expect(res.status()).toBe(200);
        expect(new URL(page.url()).pathname).toBe(`/${lang}${path}`);
      });
    }
  }
});

// The comparison pages that named competitors are gone (rule 1742): each old address answers 308 to the comparison by
// kind, in its own language, so a saved link or a search result never lands on a 404.
test.describe("retired comparison addresses", () => {
  const RETIRED = ["/vs/enrich-labs", "/vs/chatgpt", "/vs/jasper", "/vs/agency", "/vs/hootsuite", "/vs/not-a-competitor", "/blog/nashr-vs-enrich-labs"];
  for (const lang of LANGS) {
    for (const path of RETIRED) {
      test(`/${lang}${path} answers 308 to /${lang}/compare`, async ({ request }) => {
        const res = await request.get(`/${lang}${path}`, { maxRedirects: 0 });
        expect(res.status()).toBe(308);
        expect(new URL(res.headers()["location"], "http://localhost").pathname).toBe(`/${lang}/compare`);
      });
    }
  }
});

test.describe("not found", () => {
  const MISSING = ["/ar/nope", "/en/nope", "/ar/tools/not-a-tool", "/ar/blog/not-a-post", "/ar/for/not-an-industry", "/ar/agents/not-an-agent"];
  for (const path of MISSING) {
    test(`${path} answers 404`, async ({ page }) => {
      const res = await open(page, path);
      expect(res.status()).toBe(404);
    });
  }

  /**
   * What a 404 must do here, and what it cannot.
   *
   * CAN: render the product's own page — a title, both languages, a way back — for BOTH kinds of miss: a path that
   * matches no route (`/ar/nope`, caught by `[lang]/[...rest]`) and a path that matches a route which then calls
   * `notFound()` (`/ar/tools/not-a-tool`). Before this they were two different pages, one of them Next's untitled
   * English default.
   *
   * CANNOT: carry `lang`/`dir` on <html>. That element is owned by `[lang]/layout.tsx`, and Next renders
   * `not-found.tsx` outside it, as `<html id="__next_error__">`. Moving <html> to a root layout would mean the root
   * reading the language from `headers()`, which opts every page out of static rendering and would un-prerender all
   * 114 marketing URLs. The body carries `dir` on its Arabic block instead.
   */
  for (const path of ["/ar/nope", "/ar/tools/not-a-tool"]) {
    test(`${path} renders the product's own 404, not the framework's`, async ({ page }) => {
      const res = await open(page, path);
      expect(res.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "الصفحة غير موجودة" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
      await expect(page).not.toHaveTitle(/This page could not be found/);
    });
  }
});

// Rule 891: the brand pages moved under /{lang}/app/b/{id} (rule 885). An old brand path, and the three old settings
// names that now land on brand sections, answer one 307 to the same page under the session's last chosen brand, with the
// query; `/app` goes to that brand's inbox. The seeded owner's brand is "default".
test.describe("old brand paths", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  const MOVED: [string, string][] = [
    ["/en/app/tasks?id=1&x=a%20b", "/en/app/b/default/tasks?id=1&x=a+b"],
    ["/ar/app/settings/brand", "/ar/app/b/default/settings/brand"],
    ["/ar/app/onboarding", "/ar/app/b/default/settings/brand"],
    ["/en/app/integrations?error=denied", "/en/app/b/default/settings/connections?error=denied"],
    ["/en/app", "/en/app/b/default"],
  ];
  for (const [from, to] of MOVED) {
    test(`${from} answers 307 to ${to}`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      const at = new URL(res.headers()["location"], "http://localhost");
      const want = new URL(to, "http://localhost");
      expect(at.pathname).toBe(want.pathname);
      expect([...at.searchParams]).toEqual([...want.searchParams]);
    });
  }
  test("an unknown app path is still a 404", async ({ page }) => {
    const res = await open(page, "/en/app/nope");
    expect(res.status()).toBe(404);
  });
});
