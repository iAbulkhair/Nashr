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

      // #45: a shared link previews this page, not the brand word, with the share image and a large card.
      test(`${path} has its own share card`, async ({ page }) => {
        await open(page, path);
        const ogTitle = page.locator('meta[property="og:title"]').first();
        await expect(ogTitle).toHaveAttribute("content", /.+/);
        const title = await page.title();
        expect(await ogTitle.getAttribute("content"), `${path}: og:title must be the page's own title`).toBe(title);
        expect(title).not.toBe(lang === "ar" ? "ذكين" : "Thakeen");
        await expect(page.locator('meta[name="twitter:card"]').first()).toHaveAttribute("content", "summary_large_image");
        const image = await page.locator('meta[property="og:image"]').first().getAttribute("content");
        expect(image, `${path}: og:image must be an absolute https URL`).toMatch(/^https:\/\//);
        // The URL is on the canonical origin (APP_ORIGIN, or production when unset); fetch the same path from this build.
        const url = new URL(image!);
        const res = await page.request.get(url.pathname + url.search);
        expect(res.status(), `${path}: the share image must answer 200`).toBe(200);
        expect(res.headers()["content-type"]).toMatch(/^image\/png/);
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
