import { test, expect, open, LANGS } from "./fixtures/app";

for (const lang of LANGS) {
  test.describe(`home · ${lang}`, () => {
    test("renders the slogan and all eight figures", async ({ page, failures }) => {
      void failures;
      await open(page, `/${lang}`);
      await expect(page.locator("h1")).toContainText(lang === "ar" ? "ذكين. الذكي المكين." : "Thakeen. Smart. Steadfast.");
      await expect(page.getByTestId("figure")).toHaveCount(8);
      await expect(page.getByTestId("storm").locator("[data-storm-q]")).toHaveCount(36);
    });
    test("reads Noor first in the reading direction", async ({ page }) => {
      await open(page, `/${lang}`);
      const first = await page.locator('[data-testid="lineup"] [data-cast="noor"]').first().boundingBox();
      const last = await page.locator('[data-testid="lineup"] [data-cast="you"]').first().boundingBox();
      expect(lang === "ar" ? first!.x > last!.x : first!.x < last!.x).toBe(true);
    });
    test("never scrolls sideways", async ({ page }) => {
      await open(page, `/${lang}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test.describe("home without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("still shows the slogan, the lineup and a working start form", async ({ page }) => {
    await open(page, "/ar");
    await expect(page.locator("h1")).toContainText("ذكين");
    await expect(page.getByTestId("figure")).toHaveCount(8);
    const url = page.locator('form input[name="url"]:visible').first();
    await url.fill("example.sa");
    await url.press("Enter");
    await expect(page).toHaveURL(/\/ar\/app\/signup\?url=example\.sa/);
  });
});
