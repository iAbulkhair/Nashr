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

test("the story walks the chapters and gives the questions back on the way up", async ({ page }) => {
  await open(page, "/ar");
  const story = page.getByTestId("story");
  const scrollTo = (f: number) => page.evaluate((f) => {
    const s = document.querySelector('[data-testid="story"]') as HTMLElement;
    window.scrollTo(0, s.offsetTop + (s.offsetHeight - window.innerHeight) * f);
  }, f);
  await scrollTo(0.5);
  await expect(story).toHaveAttribute("data-chapter", /^[3-5]$/);
  await scrollTo(1);
  await expect(story).toHaveAttribute("data-chapter", "8");
  await expect(story.getByText("موافق.")).toBeVisible();
  await scrollTo(0);
  await expect(story).toHaveAttribute("data-chapter", "0");
  await expect(story.locator("[data-storm-q]:not([data-taken])")).toHaveCount(36);
});

test.describe("home with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("shows no storm and keeps every question still", async ({ page }) => {
    await open(page, "/en");
    await expect(page.getByTestId("storm").locator("[data-storm-q]:visible")).toHaveCount(1);
    // A lineup figure's flip: it is live on load. The story's flips sit paused until their chapter, so they would stay
    // still whatever reduced motion did. Sample only once React owns it, so the 3 s wait spans a whole 2.4 s flip.
    const q = page.getByTestId("figure").first().getByTestId("qflip");
    await expect.poll(() => q.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")))).toBe(true);
    const before = await q.textContent();
    await page.waitForTimeout(3000);
    expect(await q.textContent()).toBe(before);
  });
});
