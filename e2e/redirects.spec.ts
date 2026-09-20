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

  test("the 404 page states its language and direction", async ({ page }) => {
    await open(page, "/ar/nope");
    // Without a not-found.tsx the framework default renders <html id="__next_error__"> with no lang and no dir, which
    // is the wrong document for an Arabic-first, right-to-left product.
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});
