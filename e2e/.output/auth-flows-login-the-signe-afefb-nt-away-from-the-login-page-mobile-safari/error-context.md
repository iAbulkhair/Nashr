# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-flows.spec.ts >> login >> the signed-in owner is sent away from the login page
- Location: e2e/auth-flows.spec.ts:121:7

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "/en/app"
Received: "/en/app/login"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "Nashr" [ref=e5]:
          - /url: /en
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/app/login
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/app/login
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "Log in" [level=1] [ref=e12]
        - generic [ref=e13]:
          - textbox "Email" [ref=e14]
          - textbox "Password" [ref=e15]
          - button "Log in" [ref=e16] [cursor=pointer]
          - link "Forgot your password?" [ref=e17]:
            - /url: /en/app/forgot
        - paragraph [ref=e18]:
          - text: No account?
          - link "Create one" [ref=e19]:
            - /url: /en/app/signup
  - alert [ref=e20]
```

# Test source

```ts
  25  |     await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill("signup12345");
  26  |     await page.getByRole("button", { name: "Create account" }).click();
  27  | 
  28  |     await page.waitForURL("**/en/app/start");
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
> 125 |     expect(new URL(authed.url()).pathname).toBe("/en/app");
      |                                            ^ Error: expect(received).toBe(expected) // Object.is equality
  126 |     await signedIn.close();
  127 |     void page;
  128 |   });
  129 | });
  130 | 
  131 | test.describe("logout", () => {
  132 |   test("ends the session and the app is closed again", async ({ browser }) => {
  133 |     const signedIn = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
  134 |     const authed = await signedIn.newPage();
  135 |     await authed.goto("/en/app/profile", { waitUntil: "domcontentloaded" });
  136 |     // Log out lives in the sidebar's account menu, which has to be opened first — the trigger is the button showing
  137 |     // the signed-in address.
  138 |     await authed.getByRole("button").filter({ hasText: OWNER.email }).click();
  139 |     await authed.getByRole("button", { name: "Log out" }).click();
  140 |     await authed.waitForURL("**/app/login");
  141 | 
  142 |     await authed.goto("/en/app", { waitUntil: "domcontentloaded" });
  143 |     expect(new URL(authed.url()).pathname, "the session must be dead after logging out").toBe("/en/app/login");
  144 |     await signedIn.close();
  145 |   });
  146 | });
  147 | 
  148 | test.describe("forgot password", () => {
  149 |   test("answers the same way whether or not the address has an account", async ({ page }) => {
  150 |     const message = async (email: string) => {
  151 |       await open(page, "/en/app/forgot");
  152 |       // The field's accessible name is the page title rather than "Email" (see D15); select it by what it actually
  153 |       // announces so the test states the real, defective contract instead of the one we wish existed.
  154 |       await page.getByRole("textbox", { name: "Reset your password" }).fill(email);
  155 |       await page.getByRole("button", { name: "Send the link" }).click();
  156 |       await expect(page.getByText(/link arrives within minutes|Email delivery is not enabled/)).toBeVisible();
  157 |       return (await page.locator("main, body").innerText()).includes("Email delivery is not enabled");
  158 |     };
  159 |     const known = await message(OWNER.email);
  160 |     const unknown = await message("nobody-here@test.example");
  161 |     expect(known, "the answer must not depend on whether the account exists").toBe(unknown);
  162 |   });
  163 | });
  164 | 
  165 | test.describe("password reset", () => {
  166 |   test("a made-up token is refused", async ({ page }) => {
  167 |     await open(page, `/en/app/reset?token=${"a".repeat(64)}`);
  168 |     await page.getByRole("textbox", { name: /password/i }).fill("brandnew123");
  169 |     await page.getByRole("button", { name: "Save and log in" }).click();
  170 |     await expect(formAlert(page)).toBeVisible();
  171 |   });
  172 | });
  173 | 
```