# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app-routes.spec.ts >> app routes · ar >> /ar/app/profile renders for a signed-in owner
- Location: e2e/app-routes.spec.ts:16:11

# Error details

```
Error: /ar/app/profile must not redirect a signed-in owner

expect(received).toBe(expected) // Object.is equality

Expected: "/ar/app/profile"
Received: "/ar/app/login"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "نشر" [ref=e5]:
          - /url: /ar
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/app/login
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/app/login
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "تسجيل الدخول" [level=1] [ref=e12]
        - generic [ref=e13]:
          - textbox "البريد الإلكتروني" [ref=e14]
          - textbox "كلمة المرور" [ref=e15]
          - button "دخول" [ref=e16] [cursor=pointer]
          - link "نسيت كلمة المرور؟" [ref=e17]:
            - /url: /ar/app/forgot
        - paragraph [ref=e18]:
          - text: ما عندك حساب؟
          - link "أنشئ حساباً" [ref=e19]:
            - /url: /ar/app/signup
  - alert [ref=e20]
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
> 20 |         expect(new URL(page.url()).pathname, `${path} must not redirect a signed-in owner`).toBe(path);
     |                                                                                             ^ Error: /ar/app/profile must not redirect a signed-in owner
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
  37 |           await expect(page.locator("h1")).toContainText(route.heading.en);
  38 |         });
  39 |       }
  40 |     }
  41 |   });
  42 | }
  43 | 
```