import type { Locator } from "@playwright/test";
import { test, expect, open, LANGS, type Lang } from "./fixtures/app";
import { BANTER, CAST, HOME, type CastMember } from "../src/lib/home";

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
    // With scripts off, DOMContentLoaded does not wait for the stylesheet, and before it applies every form counts as
    // visible (the story's hidden finale form first). `load` does wait for it.
    await page.waitForLoadState("load");
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

test("plays steps 1 to 5 by keyboard with no request to the server", async ({ page }) => {
  await open(page, "/ar");
  const api: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url()); });
  const game = page.getByTestId("dictionary");
  await game.getByLabel("وش اسم علامتك؟").fill("<b>قهوة</b>" + " ".repeat(10) + "x".repeat(100));
  await game.getByRole("radio", { name: "قهوة" }).check();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "2");
  for (const w of ["جريء", "دافي", "راقي", "شعبي", "هادي"]) await game.getByRole("button", { name: w }).press("Enter");
  await expect(game.getByText("اخترت ٥ من ٥")).toBeVisible();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "4");
  await expect(game.getByText("<b>قهوة</b>", { exact: false }).first()).toBeVisible();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await game.getByRole("button", { name: "موافق" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "6");
  expect(api).toEqual([]);
});

test("the game moves focus to each new step and ends on a start form that carries the URL", async ({ page }) => {
  await open(page, "/en");
  const game = page.getByTestId("dictionary");
  const heading = game.getByRole("heading", { level: 3 });
  const next = game.getByRole("button", { name: "Next" });
  await game.getByLabel("What's your brand called?").fill("Bloom");
  await game.getByRole("radio", { name: "Clinic" }).check();
  await next.click();
  await expect(heading).toBeFocused();
  await expect(heading).toContainText("2/7");
  for (const w of ["Bold", "Warm", "Calm", "Local", "Honest"]) await game.getByRole("button", { name: w }).click();
  await expect(game.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  await expect(game.getByRole("button", { name: "Playful" })).toHaveAttribute("aria-pressed", "false");
  await expect(game.getByRole("button", { name: "Playful" })).toBeDisabled();
  await next.click();
  await expect(game.getByText("Example", { exact: true })).toHaveCount(1);
  await next.click();
  await expect(game.getByText("Example", { exact: true })).toHaveCount(2);
  await expect(game.getByText("Bloom: your health deserves an appointment today, not tomorrow.")).toBeVisible();
  await next.click();
  await game.getByRole("button", { name: "Approve" }).click();
  await expect(heading).toBeFocused();
  await next.click();
  await expect(game).toHaveAttribute("data-step", "7");
  await expect(heading).toBeFocused();
  await expect(heading).toContainText("7/7");
  const url = game.locator('form input[name="url"]');
  await url.fill("example.sa");
  await url.press("Enter");
  await expect(page).toHaveURL(/\/en\/app\/signup\?url=example\.sa/);
});

test.describe("the game with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("its bubbles appear without moving", async ({ page }) => {
    await open(page, "/en");
    const game = page.getByTestId("dictionary");
    await game.getByLabel("What's your brand called?").fill("Bloom");
    const bubble = game.getByText("Nice name. Let me get to know you.", { exact: false });
    await expect(bubble).toBeVisible();
    expect(await bubble.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });
});

test("the team talks and turns to you", async ({ page }) => {
  await open(page, "/en");
  const lineup = page.getByTestId("lineup");
  await lineup.scrollIntoViewIfNeeded();
  await expect(lineup.getByTestId("bubble").first()).toBeVisible({ timeout: 12000 });
  const noor = lineup.locator('[data-cast="noor"]').first();
  await noor.hover();
  await expect(noor.locator("svg")).toHaveAttribute("data-pose", "turn");
});

/** True once React has attached to the node, so a click reaches its handler instead of the bare server HTML. */
const live = (l: Locator) => l.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")));

test("a figure answers when you press it, once for screen readers", async ({ page }) => {
  await open(page, "/en");
  const lineup = page.getByTestId("lineup");
  const said = lineup.locator('[aria-live="polite"]');
  const noor = lineup.locator('[data-testid="figure"][data-cast="noor"]');
  // The automatic banter is decoration: its bubbles play, and screen readers hear nothing.
  await lineup.scrollIntoViewIfNeeded();
  await expect(lineup.getByTestId("bubble").first()).toBeVisible({ timeout: 4000 });
  await expect(said).toHaveText("");
  await expect.poll(() => live(noor)).toBe(true);
  const name = await noor.getAttribute("aria-label");
  await noor.click();
  // Its first line in the banter, in the speaker's bubble. The bubble is hidden from screen readers; the lineup's one
  // polite live region says it instead, and the button keeps its name.
  const bubble = noor.getByTestId("bubble");
  await expect(bubble).toHaveText("“Found a trend!”");
  await expect(bubble).toHaveAttribute("aria-hidden", "true");
  await expect(said).toHaveText("Noor: “Found a trend!”");
  await expect(noor).toHaveAccessibleName(name!);
  await expect(bubble).toHaveCount(0, { timeout: 4000 });
  // The owner has no banter line: it gives the finale's word. Keyboard activation works the same way.
  const you = lineup.locator('[data-testid="figure"][data-cast="you"]');
  await you.focus();
  await page.keyboard.press("Enter");
  await expect(you.getByTestId("bubble")).toHaveText("“Approved.”");
});

test("the motion button stops the banter and the flips, and starts them again", async ({ page }) => {
  await open(page, "/en");
  const lineup = page.getByTestId("lineup");
  await lineup.scrollIntoViewIfNeeded();
  const bubbles = lineup.getByTestId("bubble");
  await expect(bubbles.first()).toBeVisible({ timeout: 4000 });
  await lineup.getByRole("button", { name: "Pause motion", exact: true }).click();
  await expect(lineup).toHaveAttribute("data-motion", "paused");
  const toggle = lineup.getByRole("button", { name: "Play motion", exact: true });
  await expect(toggle).toBeVisible();
  // Playing, the next line would come within 2.2 s and a question would flip within 2.4 s. Paused, neither happens.
  const question = lineup.locator('[data-testid="figure"][data-cast="noor"]').getByTestId("qflip");
  const before = await question.textContent();
  await expect(bubbles).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(bubbles).toHaveCount(0);
  expect(await question.textContent()).toBe(before);
  expect(await lineup.locator('[data-part="eyes"]').first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await toggle.click();
  await expect(lineup).toHaveAttribute("data-motion", "playing");
  await expect(bubbles.first()).toBeVisible({ timeout: 4000 });
});

test("a hidden tab rests the lineup: no new line, no flip", async ({ page }) => {
  await open(page, "/en");
  const lineup = page.getByTestId("lineup");
  await lineup.scrollIntoViewIfNeeded();
  const bubbles = lineup.getByTestId("bubble");
  await expect(bubbles.first()).toBeVisible({ timeout: 4000 });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(lineup).not.toHaveAttribute("data-live");
  // Showing, the next line would come within 2.2 s and a question would flip within 2.4 s.
  const question = lineup.locator('[data-testid="figure"][data-cast="noor"]').getByTestId("qflip");
  const before = await question.textContent();
  await expect(bubbles).toHaveCount(0);
  await page.waitForTimeout(2600);
  await expect(bubbles).toHaveCount(0);
  expect(await question.textContent()).toBe(before);
});

test("the eyes follow the pointer the right way round in Arabic, and the figures blink and breathe", async ({ page, isMobile }) => {
  test.skip(isMobile, "a phone has no pointer to follow");
  await open(page, "/ar");
  const lineup = page.getByTestId("lineup");
  await lineup.scrollIntoViewIfNeeded();
  const faris = lineup.locator('[data-testid="figure"][data-cast="faris"]');
  await expect.poll(() => live(faris)).toBe(true);
  const eyes = faris.locator('[data-part="eyes"]');
  const gaze = () => eyes.evaluate((el) => parseFloat(getComputedStyle(el).translate) || 0);
  const box = (await lineup.boundingBox())!;
  // The strip's side padding, so the pointer is on the lineup but on no figure (a hovered figure faces you instead).
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  await expect.poll(gaze).toBeGreaterThan(1);
  expect(await gaze()).toBeLessThanOrEqual(3);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await expect.poll(gaze).toBeLessThan(-1);
  expect(await gaze()).toBeGreaterThanOrEqual(-3);
  expect(await eyes.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
  expect(await faris.locator('[data-part="body"]').evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
});

test.describe("the lineup with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("still answers, without moving, blinking, breathing or following the pointer", async ({ page }) => {
    await open(page, "/en");
    const lineup = page.getByTestId("lineup");
    const sami = lineup.locator('[data-testid="figure"][data-cast="sami"]');
    await expect.poll(() => live(sami)).toBe(true);
    await sami.click();
    const bubble = sami.getByTestId("bubble");
    await expect(bubble).toHaveText("“The customer wants a discount.”");
    expect(await bubble.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    const box = (await lineup.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.waitForTimeout(300);
    for (const part of ["eyes", "body"]) {
      const style = await sami.locator(`[data-part="${part}"]`).evaluate((el) => {
        const s = getComputedStyle(el);
        return { animation: s.animationName, translate: s.translate };
      });
      expect(style, part).toEqual({ animation: "none", translate: "none" });
    }
  });
});

/** Every line a figure can say, as its bubble shows it: its banter lines, and what it answers when pressed. */
function linesOf(member: CastMember, lang: Lang): string[] {
  const own = BANTER.flatMap((b) => b.lines).filter((l) => l.who === member.id).map((l) => l.text[lang]);
  const answer = member.id === "you" ? HOME.finaleWord[lang] : (own[0] ?? member.value[lang]);
  return [...new Set([...own, answer])].map((t) => (lang === "ar" ? `«${t}»` : `“${t}”`));
}

for (const width of [375, 768]) {
  test.describe(`speech bubbles at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    for (const lang of LANGS) {
      test(`every line fits above its figure and moves nothing · ${lang}`, async ({ page }) => {
        await open(page, `/${lang}`);
        const lineup = page.getByTestId("lineup");
        const row = lineup.locator("ul");
        await expect.poll(() => live(row)).toBe(true);
        const height = await row.evaluate((el) => el.getBoundingClientRect().height);
        for (const member of CAST) {
          const figure = lineup.locator(`[data-testid="figure"][data-cast="${member.id}"]`);
          await figure.click();
          await expect(figure.getByTestId("bubble")).toBeVisible();
          // Put each line in turn into the bubble on screen: it must stay inside its figure's question slot, below the
          // strip's top edge (which clips), inside the figure's column and inside the viewport.
          const outside = await figure.evaluate((el, lines) => {
            const bubble = el.querySelector('[data-testid="bubble"]') as HTMLElement;
            const shown = bubble.textContent;
            const slot = bubble.parentElement!.getBoundingClientRect();
            const column = el.getBoundingClientRect();
            const strip = el.closest("ul")!.parentElement!.getBoundingClientRect();
            const out: string[] = [];
            for (const line of lines) {
              bubble.textContent = line;
              const b = bubble.getBoundingClientRect();
              const inside =
                b.top >= slot.top - 0.5 && b.bottom <= slot.bottom + 0.5 && b.top >= strip.top - 0.5 &&
                b.left >= column.left - 0.5 && b.right <= column.right + 0.5 && b.left >= -0.5 && b.right <= innerWidth + 0.5;
              if (!inside) out.push(line);
            }
            bubble.textContent = shown;
            return out;
          }, linesOf(member, lang));
          expect(outside, member.id).toEqual([]);
          expect(await row.evaluate((el) => el.getBoundingClientRect().height), member.id).toBe(height);
        }
      });
    }
  });
}
