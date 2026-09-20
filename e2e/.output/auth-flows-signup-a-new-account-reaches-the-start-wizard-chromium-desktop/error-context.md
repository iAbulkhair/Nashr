# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-flows.spec.ts >> signup >> a new account reaches the start wizard
- Location: e2e/auth-flows.spec.ts:17:7

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: browser console errors during this test

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
+ ]
```

```
Error: page.waitForURL: Test timeout of 45000ms exceeded.
=========================== logs ===========================
waiting for navigation to "**/en/app/start" until "load"
============================================================
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
            - /url: /ar/app/signup
            - text: عربي
          - link "English" [ref=e9] [cursor=pointer]:
            - /url: /en/app/signup
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "Start your free trial" [level=1] [ref=e12]
        - paragraph [ref=e13]: 3 days, 50 credits, no card.
        - generic [ref=e14]:
          - paragraph [ref=e15]:
            - generic [ref=e16]: e2e-signup-mu9zwkul@test.example
            - button "Edit" [ref=e17]
          - textbox "Your name" [ref=e18]: E2E Signup
          - textbox "Password (8+ characters)" [ref=e19]: signup12345
          - list [ref=e20]:
            - listitem [ref=e21]: At least 8 characters
            - listitem [ref=e23]: At least one letter
            - listitem [ref=e25]: At least one number
          - alert [ref=e27]: slow_down
          - button "Create account" [ref=e28] [cursor=pointer]
        - paragraph [ref=e29]: 3-day trial · 50 credits · no card required
        - paragraph [ref=e30]:
          - text: Have an account?
          - link "Log in" [ref=e31] [cursor=pointer]:
            - /url: /en/app/login
        - paragraph [ref=e32]:
          - text: By continuing you agree to the
          - link "Terms" [ref=e33] [cursor=pointer]:
            - /url: /en/terms
          - text: and
          - link "Privacy Policy" [ref=e34] [cursor=pointer]:
            - /url: /en/privacy
          - text: .
  - alert [ref=e35]
```

# Test source

```ts
  1   | import { test, expect, open, formAlert } from "./fixtures/app";
  2   | import { OWNER, SECOND, signUpOrLogIn } from "./fixtures/accounts";
  3   | 
  4   | /**
  5   |  * The sign-up / log-in / log-out journeys, signed out. Each flow is covered for the happy path, for invalid input, and
  6   |  * for the server refusing.
  7   |  *
  8   |  * Signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), so exactly ONE test here creates an
  9   |  * account; the duplicate-address case reuses the owner created in setup. Against a server that has been up for several
  10  |  * runs the throttle can still bite — restart it, or let the `webServer` block boot a fresh one.
  11  |  */
  12  | test.use({ storageState: { cookies: [], origins: [] } });
  13  | 
  14  | const freshEmail = () => `e2e-signup-${Date.now().toString(36)}@test.example`;
  15  | 
  16  | test.describe("signup", () => {
  17  |   test("a new account reaches the start wizard", async ({ page, failures }) => {
  18  |     void failures;
  19  |     await open(page, "/en/app/signup");
  20  | 
  21  |     await page.getByRole("textbox", { name: "Email" }).fill(freshEmail());
  22  |     await page.getByRole("button", { name: "Continue" }).click();
  23  | 
  24  |     await page.getByRole("textbox", { name: "Your name" }).fill("E2E Signup");
  25  |     await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill("signup12345");
  26  |     await page.getByRole("button", { name: "Create account" }).click();
  27  | 
> 28  |     await page.waitForURL("**/en/app/start");
      |                ^ Error: page.waitForURL: Test timeout of 45000ms exceeded.
  29  |     await expect(page.getByRole("heading", { level: 1 })).toContainText("Give Noor your website");
  30  |   });
  31  | 
  32  |   test("an invalid address never leaves the first step", async ({ page }) => {
  33  |     await open(page, "/en/app/signup");
  34  |     await page.getByRole("textbox", { name: "Email" }).fill("not-an-address");
  35  |     await page.getByRole("button", { name: "Continue" }).click();
  36  |     // Still on step one: the name field belongs to step two and must not appear.
  37  |     await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  38  |     expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  39  |   });
  40  | 
  41  |   test("the submit button stays disabled until the password meets every rule", async ({ page }) => {
  42  |     await open(page, "/en/app/signup");
  43  |     await page.getByRole("textbox", { name: "Email" }).fill(freshEmail());
  44  |     await page.getByRole("button", { name: "Continue" }).click();
  45  |     await page.getByRole("textbox", { name: "Your name" }).fill("E2E");
  46  | 
  47  |     const submit = page.getByRole("button", { name: "Create account" });
  48  |     const password = page.getByRole("textbox", { name: "Password (8+ characters)" });
  49  | 
  50  |     await password.fill("short1");
  51  |     await expect(submit, "too short").toBeDisabled();
  52  |     await password.fill("nodigitshere");
  53  |     await expect(submit, "no digit").toBeDisabled();
  54  |     await password.fill("12345678");
  55  |     await expect(submit, "no letter").toBeDisabled();
  56  |     await password.fill("goodpass1");
  57  |     await expect(submit, "meets every rule").toBeEnabled();
  58  |   });
  59  | 
  60  |   test("an address that already has an account is refused with a reason", async ({ page }) => {
  61  |     await open(page, "/en/app/signup");
  62  |     await page.getByRole("textbox", { name: "Email" }).fill(OWNER.email);
  63  |     await page.getByRole("button", { name: "Continue" }).click();
  64  |     await page.getByRole("textbox", { name: "Your name" }).fill("Duplicate");
  65  |     await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill("another123");
  66  |     await page.getByRole("button", { name: "Create account" }).click();
  67  | 
  68  |     // 409 already registered, or 429 when the throttle answers first — both must surface a message, not a blank screen.
  69  |     await expect(formAlert(page)).toBeVisible();
  70  |     expect(new URL(page.url()).pathname).toBe("/en/app/signup");
  71  |   });
  72  | });
  73  | 
  74  | test.describe("login", () => {
  75  |   /**
  76  |    * Logging in is throttled per account (eight per fifteen minutes, `src/app/api/auth/login/route.ts`). The happy path
  77  |    * therefore uses the second account rather than the owner, so one rerun of the suite cannot exhaust either budget.
  78  |    */
  79  |   test("correct credentials reach the app", async ({ page, request, failures }) => {
  80  |     void failures;
  81  |     await signUpOrLogIn(request, SECOND);
  82  |     await open(page, "/en/app/login");
  83  |     await page.getByRole("textbox", { name: "Email" }).fill(SECOND.email);
  84  |     await page.getByRole("textbox", { name: "Password" }).fill(SECOND.password);
  85  |     await page.getByRole("button", { name: "Log in" }).click();
  86  | 
  87  |     // No brand file on this account, so the inbox hands off to the start wizard. That redirect is the proof the
  88  |     // session was established.
  89  |     await page.waitForURL("**/en/app/start");
  90  |     await expect(page.getByRole("heading", { level: 1 })).toContainText("Give Noor your website");
  91  |   });
  92  | 
  93  |   test("a wrong password says so and stays put", async ({ page }) => {
  94  |     await open(page, "/en/app/login");
  95  |     await page.getByRole("textbox", { name: "Email" }).fill(OWNER.email);
  96  |     await page.getByRole("textbox", { name: "Password" }).fill("definitely-wrong");
  97  |     await page.getByRole("button", { name: "Log in" }).click();
  98  | 
  99  |     await expect(formAlert(page)).toHaveText("Wrong email or password.");
  100 |     expect(new URL(page.url()).pathname).toBe("/en/app/login");
  101 |   });
  102 | 
  103 |   test("an unknown address gets the same message as a wrong password", async ({ page }) => {
  104 |     await open(page, "/en/app/login");
  105 |     await page.getByRole("textbox", { name: "Email" }).fill("nobody-here@test.example");
  106 |     await page.getByRole("textbox", { name: "Password" }).fill("whatever123");
  107 |     await page.getByRole("button", { name: "Log in" }).click();
  108 |     // Identical wording for both cases: the form must not reveal which addresses have accounts.
  109 |     await expect(formAlert(page)).toHaveText("Wrong email or password.");
  110 |   });
  111 | 
  112 |   test("an empty form does not reach the server", async ({ page }) => {
  113 |     await open(page, "/en/app/login");
  114 |     let posted = false;
  115 |     page.on("request", (r) => { if (r.url().includes("/api/auth/login")) posted = true; });
  116 |     await page.getByRole("button", { name: "Log in" }).click();
  117 |     await expect(page.getByRole("textbox", { name: "Email" })).toBeFocused();
  118 |     expect(posted, "required fields must stop the submit in the browser").toBe(false);
  119 |   });
  120 | 
  121 |   test("the signed-in owner is sent away from the login page", async ({ page, browser }) => {
  122 |     const signedIn = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
  123 |     const authed = await signedIn.newPage();
  124 |     await authed.goto("/en/app/login", { waitUntil: "domcontentloaded" });
  125 |     expect(new URL(authed.url()).pathname).toBe("/en/app");
  126 |     await signedIn.close();
  127 |     void page;
  128 |   });
```