# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-flows.spec.ts >> password reset >> a made-up token is refused
- Location: e2e/auth-flows.spec.ts:166:7

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: locator.click: Test timeout of 45000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Save and log in' })
    - locator resolved to <button disabled class="btn btn-primary">Save and log in</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    87 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "Nashr" [ref=e5]:
          - /url: /en
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/app/reset
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/app/reset
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "New password" [level=1] [ref=e12]
        - generic [ref=e13]:
          - textbox "New password" [active] [ref=e14]: brandnew123
          - list [ref=e15]:
            - listitem [ref=e16]: At least 8 characters
            - listitem [ref=e18]: At least one letter
            - listitem [ref=e20]: At least one number
          - button "Save and log in" [disabled] [ref=e22]
  - alert [ref=e23]
```

# Test source

```ts
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
> 169 |     await page.getByRole("button", { name: "Save and log in" }).click();
      |                                                                 ^ Error: locator.click: Test timeout of 45000ms exceeded.
  170 |     await expect(formAlert(page)).toBeVisible();
  171 |   });
  172 | });
  173 | 
```