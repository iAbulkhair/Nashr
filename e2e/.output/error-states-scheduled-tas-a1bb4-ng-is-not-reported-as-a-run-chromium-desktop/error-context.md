# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: error-states.spec.ts >> scheduled tasks report what actually happened >> a run that produced nothing is not reported as a run
- Location: e2e/error-states.spec.ts:39:7

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: locator.click: Test timeout of 45000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Run now' }).first()

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "Nashr" [ref=e5] [cursor=pointer]:
          - /url: /en
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8] [cursor=pointer]:
            - /url: /ar/app/login
            - text: عربي
          - link "English" [ref=e9] [cursor=pointer]:
            - /url: /en/app/login
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "Log in" [level=1] [ref=e12]
        - generic [ref=e13]:
          - textbox "Email" [ref=e14]
          - textbox "Password" [ref=e15]
          - button "Log in" [ref=e16] [cursor=pointer]
          - link "Forgot your password?" [ref=e17] [cursor=pointer]:
            - /url: /en/app/forgot
        - paragraph [ref=e18]:
          - text: No account?
          - link "Create one" [ref=e19] [cursor=pointer]:
            - /url: /en/app/signup
  - alert [ref=e20]
```

# Test source

```ts
  1  | import { test, expect, open } from "./fixtures/app";
  2  | 
  3  | /**
  4  |  * Server-error states, forced with route interception because they cannot be produced by using the app normally.
  5  |  *
  6  |  * Both panels used to call `await res.json()` with no try/catch on a route that can answer 502 with an HTML body, and
  7  |  * both cleared their busy flag only on the success path — so one gateway failure disabled the controls until the owner
  8  |  * reloaded the page, with the status text frozen on "running".
  9  |  */
  10 | test.use({ storageState: "e2e/.auth/owner.json" });
  11 | 
  12 | test.describe("generate panel survives a failing request", () => {
  13 |   test("a gateway error re-enables the buttons and says something went wrong", async ({ page }) => {
  14 |     await open(page, "/en/app/generate");
  15 |     const button = page.getByRole("button", { name: /social/i }).first();
  16 |     await expect(button).toBeEnabled();
  17 | 
  18 |     // A platform 502 returns HTML, not JSON: this is the body that used to make res.json() throw.
  19 |     await page.route("**/api/generate", (route) =>
  20 |       route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));
  21 | 
  22 |     await button.click();
  23 |     await expect(button, "the panel must not stay wedged after a failure").toBeEnabled({ timeout: 15_000 });
  24 |     await expect(page.getByText(/failed/i)).toBeVisible();
  25 |   });
  26 | 
  27 |   test("a dropped connection is handled the same way", async ({ page }) => {
  28 |     await open(page, "/en/app/generate");
  29 |     const button = page.getByRole("button", { name: /social/i }).first();
  30 |     await page.route("**/api/generate", (route) => route.abort("connectionfailed"));
  31 | 
  32 |     await button.click();
  33 |     await expect(button).toBeEnabled({ timeout: 15_000 });
  34 |     await expect(page.getByText(/failed/i)).toBeVisible();
  35 |   });
  36 | });
  37 | 
  38 | test.describe("scheduled tasks report what actually happened", () => {
  39 |   test("a run that produced nothing is not reported as a run", async ({ page }) => {
  40 |     await open(page, "/en/app/tasks");
  41 |     // The schedule route answers 200 with the reason in `result`; "no_credits" means nothing was generated and no
  42 |     // credits moved. It used to render as "Ran: no_credits".
  43 |     await page.route("**/api/schedule", (route) =>
  44 |       route.request().method() === "POST"
  45 |         ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: "no_credits" }) })
  46 |         : route.continue());
  47 | 
  48 |     const run = page.getByRole("button", { name: "Run now" }).first();
> 49 |     await run.click();
     |               ^ Error: locator.click: Test timeout of 45000ms exceeded.
  50 |     // The success prefix in English is "Done" (app-i18n `tasks.ran`). Before the fix the owner was shown
  51 |     // "Done: no_credits" for a run that generated nothing and moved no credits.
  52 |     await expect(page.getByText(/Generation failed/)).toBeVisible();
  53 |     await expect(page.getByText(/Done: no_credits/), "a run that did nothing must not be reported as done").toHaveCount(0);
  54 |     await expect(run, "the button must come back either way").toBeEnabled({ timeout: 15_000 });
  55 |   });
  56 | 
  57 |   test("a 500 does not leave the buttons disabled", async ({ page }) => {
  58 |     await open(page, "/en/app/tasks");
  59 |     await page.route("**/api/schedule", (route) =>
  60 |       route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "text/html", body: "<html>boom</html>" }) : route.continue());
  61 | 
  62 |     const run = page.getByRole("button", { name: "Run now" }).first();
  63 |     await run.click();
  64 |     await expect(run).toBeEnabled({ timeout: 15_000 });
  65 |   });
  66 | });
  67 | 
```