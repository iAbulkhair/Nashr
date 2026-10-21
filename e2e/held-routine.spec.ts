import { test, expect, open, LANGS } from "./fixtures/app";
import { simulatedIp } from "./fixtures/accounts";
import { E2E_ADMIN_KEY, E2E_CRON_REPORT, HELD_ROUTINE } from "./web-server";
import { appDict } from "../src/lib/app-i18n";

/**
 * Rules 2593-2594: the two screens of the paid-cron work (#404) in a real browser. No request can make a run the cron held
 * after a kill, or a cron's last report, so the end-to-end server starts with both in its memory store (`E2E_SEED_KV`,
 * rule 2590): this month's Razan routine held for the seeded owner, and a daily report. The model is mocked here, so the
 * owner's Run answers `skip:mock` before the held check; that the Run resumes the held claim and charges it once is pinned
 * by tests/paid-cron-held.test.ts (rule 2479). What this spec adds is the page, the button and the request it sends.
 */
test.describe("Scheduled tasks: a held routine and its Run button (rule 2593)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  for (const lang of LANGS) {
    test(`${lang}: the held routine shows its note, and Run posts that routine`, async ({ page }) => {
      const t = appDict[lang].tasks;
      await open(page, `/${lang}/app/tasks`);
      const block = page.locator(`[data-held="${HELD_ROUTINE}"]`);
      await expect(block).toBeVisible();
      await expect(page.locator("[data-held]"), "only the held routine").toHaveCount(1);
      await expect(block).toContainText(t.held);
      const sent = page.waitForResponse((r) => r.url().endsWith("/api/schedule") && r.request().method() === "POST");
      await block.getByRole("button", { name: t.runHeld }).click();
      const res = await sent;
      expect(res.request().postDataJSON()).toEqual({ run: "routine", id: HELD_ROUTINE });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true, result: "skip:mock" });
    });
  }
});

test.describe("Founder console: the daily batch counts under the heartbeat (rule 2594)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the key session opens Usage, and the daily job shows its last report in both languages", async ({ page, baseURL }) => {
    const login = await page.request.post(`${baseURL}/api/admin/login`, { headers: { "x-forwarded-for": simulatedIp("held-routine-usage") }, data: { key: E2E_ADMIN_KEY } });
    expect(login.status(), await login.text()).toBe(200);
    const r = E2E_CRON_REPORT;
    // Both templates read done, ran, held, failed, left, of total (OV.cronReport in src/components/admin/shared.tsx).
    const counts = new RegExp([r.alreadyDone, r.processed, r.held, r.failed, r.remaining, r.total].join("\\D+"));
    for (const lang of LANGS) {
      await open(page, `/${lang}/admin/usage`);
      const line = page.locator('[data-cron-report="daily"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveText(counts);
    }
  });
});
