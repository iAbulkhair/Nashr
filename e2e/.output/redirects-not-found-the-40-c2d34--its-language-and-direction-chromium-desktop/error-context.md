# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: redirects.spec.ts >> not found >> the 404 page states its language and direction
- Location: e2e/redirects.spec.ts:54:7

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  locator('html')
Expected: "ar"
Received: ""
Timeout:  10000ms

Call log:
  - Expect "toHaveAttribute" locator('html') with timeout 10000ms
  - waiting for locator('html')
    24 × locator resolved to <html>…</html>
       - unexpected value "null"

```

```yaml
- document:
  - heading "404" [level=1]
  - heading "This page could not be found." [level=2]
  - alert
```

# Test source

```ts
  1  | import { test, expect, open, LANGS } from "./fixtures/app";
  2  | import { APP_ROUTES, APP_PUBLIC_ROUTES } from "./fixtures/routes";
  3  | 
  4  | test.describe("language routing", () => {
  5  |   test("/ sends an English browser to /en", async ({ page }) => {
  6  |     const res = await open(page, "/");
  7  |     expect(res.status()).toBe(200);
  8  |     expect(new URL(page.url()).pathname).toBe("/en");
  9  |   });
  10 | 
  11 |   test("the nashr_lang cookie wins over Accept-Language", async ({ page, context }) => {
  12 |     await context.addCookies([{ name: "nashr_lang", value: "ar", url: "http://localhost" }]);
  13 |     await open(page, "/");
  14 |     expect(new URL(page.url()).pathname).toBe("/ar");
  15 |   });
  16 | 
  17 |   test("an unknown language is a 404, not a redirect", async ({ page }) => {
  18 |     const res = await open(page, "/xx");
  19 |     expect(res.status()).toBe(404);
  20 |   });
  21 | });
  22 | 
  23 | test.describe("unauthenticated access to the app", () => {
  24 |   for (const lang of LANGS) {
  25 |     for (const route of APP_ROUTES) {
  26 |       test(`/${lang}${route.path} sends a signed-out visitor to the login page`, async ({ page }) => {
  27 |         const res = await open(page, `/${lang}${route.path}`);
  28 |         expect(res.status()).toBe(200);
  29 |         expect(new URL(page.url()).pathname, `${route.path} must not render for a signed-out visitor`).toBe(`/${lang}/app/login`);
  30 |       });
  31 |     }
  32 |   }
  33 | 
  34 |   for (const lang of LANGS) {
  35 |     for (const path of APP_PUBLIC_ROUTES.filter((p) => p !== "/app/admin")) {
  36 |       test(`/${lang}${path} is reachable signed out`, async ({ page }) => {
  37 |         const res = await open(page, `/${lang}${path}`);
  38 |         expect(res.status()).toBe(200);
  39 |         expect(new URL(page.url()).pathname).toBe(`/${lang}${path}`);
  40 |       });
  41 |     }
  42 |   }
  43 | });
  44 | 
  45 | test.describe("not found", () => {
  46 |   const MISSING = ["/ar/nope", "/en/nope", "/ar/tools/not-a-tool", "/ar/blog/not-a-post", "/ar/for/not-an-industry", "/ar/vs/not-a-competitor", "/ar/agents/not-an-agent"];
  47 |   for (const path of MISSING) {
  48 |     test(`${path} answers 404`, async ({ page }) => {
  49 |       const res = await open(page, path);
  50 |       expect(res.status()).toBe(404);
  51 |     });
  52 |   }
  53 | 
  54 |   test("the 404 page states its language and direction", async ({ page }) => {
  55 |     await open(page, "/ar/nope");
  56 |     // Without a not-found.tsx the framework default renders <html id="__next_error__"> with no lang and no dir, which
  57 |     // is the wrong document for an Arabic-first, right-to-left product.
> 58 |     await expect(page.locator("html")).toHaveAttribute("lang", "ar");
     |                                        ^ Error: expect(locator).toHaveAttribute(expected) failed
  59 |     await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  60 |   });
  61 | });
  62 | 
```