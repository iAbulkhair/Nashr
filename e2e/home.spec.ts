import { test, expect, open, LANGS } from "./fixtures/app";
import { CAST } from "../src/lib/home";

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
    test("the Industries tab leads to a page that exists", async ({ page }) => {
      await open(page, `/${lang}`);
      const industries = page.locator('nav[aria-label="Main"] a[aria-haspopup]', { hasText: lang === "ar" ? "القطاعات" : "Industries" });
      await expect(industries).toHaveAttribute("href", `/${lang}/customers`);
      await expect(page.locator('a[href$="#industries"]')).toHaveCount(0);
    });
  });
}

test.describe("home on a tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 }, reducedMotion: "reduce" });
  for (const lang of LANGS) {
    test(`every question fits above its figure · ${lang}`, async ({ page }) => {
      await open(page, `/${lang}`);
      const lineup = page.getByTestId("lineup");
      await expect(lineup.getByTestId("qflip")).toHaveCount(CAST.filter((m) => m.questions.length > 0).length);
      // Put each question in turn into the bubble on screen; it must stay inside its slot and below the strip's top
      // edge, which clips anything above it.
      const clipped = await lineup.evaluate(
        (section, { cast, lang }) => {
          const strip = section.querySelector("ul")!.parentElement!.getBoundingClientRect();
          const out: string[] = [];
          for (const m of cast) {
            const flip = section.querySelector(`[data-testid="figure"][data-cast="${m.id}"] [data-testid="qflip"]`);
            if (!flip) continue;
            const bubble = flip.firstElementChild as HTMLElement;
            const shown = bubble.textContent;
            for (const q of m.questions) {
              bubble.textContent = q[lang];
              const b = bubble.getBoundingClientRect();
              const slot = flip.parentElement!.getBoundingClientRect();
              if (b.top < slot.top - 0.5 || b.bottom > slot.bottom + 0.5 || b.top < strip.top - 0.5) out.push(`${m.id}: ${q[lang]}`);
            }
            bubble.textContent = shown;
          }
          return out;
        },
        { cast: CAST, lang },
      );
      expect(clipped).toEqual([]);
    });
  }
});

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
