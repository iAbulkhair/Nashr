# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app-routes.spec.ts >> app routes · en >> /en/app/chat names itself in its heading
- Location: e2e/app-routes.spec.ts:35:13

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('h1')
Expected substring: "Noor"
Received string:    "Log in"
Timeout: 10000ms

Call log:
  - Expect "toContainText" locator('h1') with timeout 10000ms
  - waiting for locator('h1')
    24 × locator resolved to <h1 class="page-title">Log in</h1>
       - unexpected value "Log in"

```

```yaml
- heading "Log in" [level=1]
```

# Test source

```ts
  1  | import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
  2  | import { APP_ROUTES } from "./fixtures/routes";
  3  | 
  4  | /**
  5  |  * Per-route contract for every authenticated page. The owner is signed in and has a brand file (e2e/auth.setup.ts), so
  6  |  * these pages render their own content rather than redirecting to the start wizard; the redirect itself is covered by
  7  |  * onboarding.spec.ts with an account that has no brand.
  8  |  */
  9  | test.use({ storageState: "e2e/.auth/owner.json" });
  10 | 
  11 | for (const lang of LANGS) {
  12 |   test.describe(`app routes · ${lang}`, () => {
  13 |     for (const route of APP_ROUTES) {
  14 |       const path = `/${lang}${route.path}`;
  15 | 
  16 |       test(`${path} renders for a signed-in owner`, async ({ page, failures }) => {
  17 |         void failures;
  18 |         const res = await open(page, path);
  19 |         expect(res.status(), `${path} must answer 200`).toBe(200);
  20 |         expect(new URL(page.url()).pathname, `${path} must not redirect a signed-in owner`).toBe(path);
  21 | 
  22 |         const html = page.locator("html");
  23 |         await expect(html).toHaveAttribute("lang", lang);
  24 |         await expect(html).toHaveAttribute("dir", dirFor(lang));
  25 | 
  26 |         // Every page must name itself. A page whose only heading lives in the shared sidebar is indistinguishable
  27 |         // from every other page for a screen reader and for anyone landing on it from a link.
  28 |         await expect(page.locator("h1"), `${path} must have exactly one h1`).toHaveCount(1);
  29 |       });
  30 |     }
  31 | 
  32 |     // The heading text is language-specific and only recorded for English; assert it there.
  33 |     if (lang === "en") {
  34 |       for (const route of APP_ROUTES) {
  35 |         test(`/en${route.path} names itself in its heading`, async ({ page }) => {
  36 |           await open(page, `/en${route.path}`);
> 37 |           await expect(page.locator("h1")).toContainText(route.heading.en);
     |                                            ^ Error: expect(locator).toContainText(expected) failed
  38 |         });
  39 |       }
  40 |     }
  41 |   });
  42 | }
  43 | 
```