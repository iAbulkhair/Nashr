import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
import { PUBLIC_ROUTES, DEFAULT_TITLE } from "./fixtures/routes";

/**
 * Per-route contract for every public marketing page, in both languages: it answers 200, it says which language and
 * direction it is in, it has exactly one first-level heading, it carries a title that identifies the page rather than
 * the site, and it loads without a console error or a failed request (both asserted by the `failures` fixture).
 */
for (const lang of LANGS) {
  test.describe(`public pages · ${lang}`, () => {
    for (const route of PUBLIC_ROUTES) {
      const path = `/${lang}${route.path}`;

      test(`${path} renders`, async ({ page, failures }) => {
        void failures; // the fixture asserts console and network cleanliness at teardown
        const res = await open(page, path);
        expect(res.status(), `${path} must answer 200`).toBe(200);

        const html = page.locator("html");
        await expect(html).toHaveAttribute("lang", lang);
        await expect(html).toHaveAttribute("dir", dirFor(lang));

        await expect(page.locator("h1"), `${path} must have exactly one h1`).toHaveCount(1);

        const unique = route.unique[lang];
        await expect(page.locator("body"), `${path} must render its own content`).toContainText(unique);
      });

      if (route.ownTitle) {
        test(`${path} has its own title`, async ({ page }) => {
          await open(page, path);
          const title = await page.title();
          expect(title.length, `${path} must have a title`).toBeGreaterThan(0);
          expect(title, `${path} must not fall back to the site-wide default title`).not.toBe(DEFAULT_TITLE[lang]);
        });
      }
    }
  });
}
