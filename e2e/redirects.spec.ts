import { test, expect, open, LANGS } from "./fixtures/app";
import { APP_ROUTES, APP_PUBLIC_ROUTES } from "./fixtures/routes";

test.describe("language routing", () => {
  test("/ sends an English browser to /en", async ({ page }) => {
    const res = await open(page, "/");
    expect(res.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/en");
  });

  test("the nashr_lang cookie wins over Accept-Language", async ({ page, context }) => {
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

test.describe("not found", () => {
  const MISSING = ["/ar/nope", "/en/nope", "/ar/tools/not-a-tool", "/ar/blog/not-a-post", "/ar/for/not-an-industry", "/ar/vs/not-a-competitor", "/ar/agents/not-an-agent"];
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
