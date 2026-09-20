import { test, expect, open } from "./fixtures/app";

/**
 * Server-error states, forced with route interception because they cannot be produced by using the app normally.
 *
 * Both panels used to call `await res.json()` with no try/catch on a route that can answer 502 with an HTML body, and
 * both cleared their busy flag only on the success path — so one gateway failure disabled the controls until the owner
 * reloaded the page, with the status text frozen on "running".
 */
test.use({ storageState: "e2e/.auth/owner.json" });

test.describe("generate panel survives a failing request", () => {
  test("a gateway error re-enables the buttons and says something went wrong", async ({ page }) => {
    await open(page, "/en/app/generate");
    const button = page.getByRole("button", { name: /social/i }).first();
    await expect(button).toBeEnabled();

    // A platform 502 returns HTML, not JSON: this is the body that used to make res.json() throw.
    await page.route("**/api/generate", (route) =>
      route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));

    await button.click();
    await expect(button, "the panel must not stay wedged after a failure").toBeEnabled({ timeout: 15_000 });
    await expect(page.getByText(/failed/i)).toBeVisible();
  });

  test("a dropped connection is handled the same way", async ({ page }) => {
    await open(page, "/en/app/generate");
    const button = page.getByRole("button", { name: /social/i }).first();
    await page.route("**/api/generate", (route) => route.abort("connectionfailed"));

    await button.click();
    await expect(button).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByText(/failed/i)).toBeVisible();
  });
});

test.describe("scheduled tasks report what actually happened", () => {
  test("a run that produced nothing is not reported as a run", async ({ page }) => {
    await open(page, "/en/app/tasks");
    // The schedule route answers 200 with the reason in `result`; "no_credits" means nothing was generated and no
    // credits moved. It used to render as "Ran: no_credits".
    await page.route("**/api/schedule", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: "no_credits" }) })
        : route.continue());

    const run = page.getByRole("button", { name: "Run now" }).first();
    await run.click();
    // The success prefix in English is "Done" (app-i18n `tasks.ran`). Before the fix the owner was shown
    // "Done: no_credits" for a run that generated nothing and moved no credits.
    await expect(page.getByText(/Generation failed/)).toBeVisible();
    await expect(page.getByText(/Done: no_credits/), "a run that did nothing must not be reported as done").toHaveCount(0);
    await expect(run, "the button must come back either way").toBeEnabled({ timeout: 15_000 });
  });

  test("a 500 does not leave the buttons disabled", async ({ page }) => {
    await open(page, "/en/app/tasks");
    await page.route("**/api/schedule", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "text/html", body: "<html>boom</html>" }) : route.continue());

    const run = page.getByRole("button", { name: "Run now" }).first();
    await run.click();
    await expect(run).toBeEnabled({ timeout: 15_000 });
  });
});
