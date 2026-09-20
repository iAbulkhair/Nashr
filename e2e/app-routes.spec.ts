import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
import { APP_ROUTES } from "./fixtures/routes";

/**
 * Per-route contract for every authenticated page. The owner is signed in and has a brand file (e2e/auth.setup.ts), so
 * these pages render their own content rather than redirecting to the start wizard; the redirect itself is covered by
 * onboarding.spec.ts with an account that has no brand.
 */
test.use({ storageState: "e2e/.auth/owner.json" });

for (const lang of LANGS) {
  test.describe(`app routes · ${lang}`, () => {
    for (const route of APP_ROUTES) {
      const path = `/${lang}${route.path}`;

      test(`${path} renders for a signed-in owner`, async ({ page, failures }) => {
        void failures;
        const res = await open(page, path);
        expect(res.status(), `${path} must answer 200`).toBe(200);
        expect(new URL(page.url()).pathname, `${path} must not redirect a signed-in owner`).toBe(path);

        const html = page.locator("html");
        await expect(html).toHaveAttribute("lang", lang);
        await expect(html).toHaveAttribute("dir", dirFor(lang));

        // Every page must name itself. A page whose only heading lives in the shared sidebar is indistinguishable
        // from every other page for a screen reader and for anyone landing on it from a link. Asserted in the same
        // visit rather than a second one: re-navigating to all twenty routes bought no extra coverage and doubled the
        // load on the single server both projects share, which showed up as timeouts on whichever route lost the race.
        const h1 = page.locator("h1");
        await expect(h1, `${path} must have exactly one h1`).toHaveCount(1);
        if (lang === "en") await expect(h1, `${path} must name itself`).toContainText(route.heading.en);
      });
    }
  });
}
