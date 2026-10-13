import { test, expect, open, LANGS } from "./fixtures/app";
import { CAST, HERO, HOME_FAQ, HOME_NAV, STEPS } from "../src/lib/home";
import { dict } from "../src/lib/i18n";
import { CLAUDE_PAUSED } from "../src/lib/model";

/**
 * The homepage is prototype D (rule 516): the cover with the team, the house rules, your day, the seven steps, the
 * plans and the questions, in that order, each reachable from the nav. The lineup is the one interactive part; the
 * doodles and seams move only without reduced motion and stop with the page's pause button.
 */

// The gallery (rule 1220) sits after your day and has no nav link: its copy stays out of src/lib/home.ts. The closing
// call (rule 1600, `#start`) is the last block of <main> and has no nav link either: the cover already carries the call.
const SECTIONS = [...HOME_NAV.map((n) => n.href.slice(1)).flatMap((id) => (id === "day" ? [id, "gallery"] : [id])), "start"];

for (const lang of LANGS) {
  test.describe(`home · ${lang}`, () => {
    test("shows D's sections in order, the masthead and the whole team", async ({ page, failures }) => {
      void failures;
      await open(page, `/${lang}`);
      await expect(page.locator("h1")).toContainText(HERO.tbox[lang]);
      await expect(page.getByTestId("lineup").locator("[data-id]")).toHaveCount(CAST.length);
      const ids = await page.locator("main > section[id]").evaluateAll((els) => els.map((e) => e.id));
      expect(ids).toEqual(SECTIONS);
      // Drawn without markers, these lists keep their semantics in Safari only with an explicit role.
      for (const list of await page.locator("main ul, main ol").all()) await expect(list).toHaveAttribute("role", "list");
    });

    test("the nav leads to every section", async ({ page }) => {
      await open(page, `/${lang}`);
      for (const { href } of HOME_NAV) {
        await expect(page.locator(`header a[href="${href}"]`).first()).toBeAttached();
        await expect(page.locator(href)).toHaveCount(1);
      }
    });

    test("reads Noor first in the reading direction", async ({ page }) => {
      await open(page, `/${lang}`);
      const first = await page.locator('[data-testid="lineup"] [data-id="noor"]').boundingBox();
      const last = await page.locator('[data-testid="lineup"] [data-id="you"]').boundingBox();
      expect(lang === "ar" ? first!.x > last!.x : first!.x < last!.x).toBe(true);
    });

    test("lists every public plan from the pricing block, the agency plan leading to the contact form", async ({ page }) => {
      await open(page, `/${lang}`);
      const plans = page.locator("#price li h3");
      const names = dict[lang].pricing.plans.map((p) => p.name);
      await expect(plans).toHaveCount(4);
      for (const name of await plans.allTextContents()) expect(names).toContain(name);
      await expect(page.locator(`#price a[href="/${lang}/enterprise#contact"]`)).toHaveCount(1);
      await expect(page.locator(`#price a[href="/${lang}/app/signup"]`)).toHaveCount(3);
    });

    test("says what is paused today on the steps it affects", async ({ page }) => {
      await open(page, `/${lang}`);
      for (const s of STEPS.filter((st) => st.paused)) {
        await expect(page.locator("#steps").getByText(s.paused![lang], { exact: true })).toHaveCount(CLAUDE_PAUSED ? 1 : 0);
      }
    });

    test("never scrolls sideways", async ({ page }) => {
      await open(page, `/${lang}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test.describe("home without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("still shows the masthead, the team and the plans, and the questions open", async ({ page }) => {
    await open(page, "/ar");
    await page.waitForLoadState("load");
    await expect(page.locator("h1")).toContainText(HERO.tbox.ar);
    await expect(page.getByTestId("lineup").locator("[data-id]")).toHaveCount(CAST.length);
    await expect(page.locator("#price li h3")).toHaveCount(4);
    const q = page.locator("#faq details").first();
    await q.locator("summary").click();
    await expect(q).toHaveAttribute("open", "");
    await expect(q.getByText(HOME_FAQ[0].a.ar)).toBeVisible();
  });
});

test.describe("the lineup", () => {
  test("by keyboard: the first figure takes its colour and thinks a question, Escape puts it back", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard focus");
    await open(page, "/ar");
    const lineup = page.getByTestId("lineup");
    const noor = lineup.locator('[data-id="noor"]');
    // Only once React owns the button does focusing it do anything.
    await expect.poll(() => noor.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")))).toBe(true);
    // Tab in from the button before it, so the focus is keyboard focus (:focus-visible).
    await lineup.locator("button:not([data-id])").first().focus();
    await page.keyboard.press("Tab");
    await expect(noor).toBeFocused();
    const cloud = lineup.locator(".s-cloud");
    await expect(cloud).toHaveAttribute("data-on", "");
    expect((await cloud.textContent())?.trim().length).toBeGreaterThan(0);
    const fill = await noor.locator(".s-tag .fill").evaluate((p) => getComputedStyle(p).fill);
    const agent = await noor.evaluate((el) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--color-agent-noor)";
      el.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(fill).toBe(agent);
    await page.keyboard.press("Escape");
    await expect(cloud).not.toHaveAttribute("data-on", "");
  });

  test("the chosen figure grows by a transform only: no other figure moves", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover");
    await open(page, "/en");
    const places = page.getByTestId("lineup").locator("li");
    // The cover's call to action (rule 1228) pushes the team down, so at 900px high it sits partly below the fold. Hover
    // scrolls such a figure into view, and every viewport-relative rect then moves with the page, not with a layout
    // shift. Bring the whole lineup into view first (the page scrolls smoothly, so ask for an instant jump) so the page does
    // not scroll between the two measurements.
    await page.getByTestId("lineup").evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    const rects = () => places.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    const before = await rects();
    await page.getByTestId("lineup").locator('[data-id="faris"]').hover();
    await page.waitForTimeout(600);
    expect(await rects()).toEqual(before);
  });

  test("Enter then Tab: only the focused figure is pressed", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard focus");
    await open(page, "/en");
    const lineup = page.getByTestId("lineup");
    const noor = lineup.locator('[data-id="noor"]');
    await expect.poll(() => noor.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")))).toBe(true);
    await lineup.locator("button:not([data-id])").first().focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(noor).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(noor).toHaveAttribute("aria-pressed", "false");
    await expect(lineup.locator('[aria-pressed="true"]')).toHaveCount(0);
  });

  test("the live region speaks for keyboard and taps, not for a passing mouse", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover");
    await open(page, "/en");
    const lineup = page.getByTestId("lineup");
    const live = lineup.locator('[aria-live="polite"]');
    const faris = lineup.locator('[data-id="faris"]');
    await expect.poll(() => faris.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")))).toBe(true);
    await faris.hover();
    await expect(lineup.locator(".s-cloud")).toHaveAttribute("data-on", "");
    await expect(live).toHaveText("");
    await faris.click();
    await expect(live).not.toHaveText("");
  });
});

test.describe("home with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("nothing moves", async ({ page }) => {
    await open(page, "/en");
    await page.waitForLoadState("load");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

test("the pause button stops every doodle and seam, and starts them again", async ({ page }) => {
  await open(page, "/ar");
  await page.waitForLoadState("load");
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
  expect(await running()).toBeGreaterThan(0);
  const toggle = page.getByTestId("lineup").locator("button:not([data-id])").first();
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect.poll(running).toBe(0);
  await toggle.click();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion", "off");
  await expect.poll(running).toBeGreaterThan(0);
});
