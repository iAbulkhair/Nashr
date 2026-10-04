import { expect, test, type Page } from "@playwright/test";

/**
 * The re-skin's layout matrix: every page moved to prototype D, in Arabic and English, at five widths, must not scroll
 * sideways and must keep every visible element inside the viewport. Each page also leaves a full-page screenshot in
 * `e2e/.output/reskin/<engine>/` for a human to look at. Runs in Chromium in CI; `E2E_WEBKIT=1` adds WebKit.
 */

/** Paths after the language prefix. Each re-skin task adds the pages it moves. */
export const PAGES: string[] = ["", "/pricing", "/app/login", "/agents", "/agents/faris", "/for/ecommerce", "/vs/chatgpt", "/ai-marketing-agent", "/customers", "/enterprise", "/tools", "/tools/hook-generator", "/blog", "/blog/ramadan-marketing-guide-2026", "/help", "/resources", "/updates", "/affiliates", "/affiliates/terms", "/privacy", "/terms", "/not-a-page", "/app/signup", "/app/forgot", "/app/reset", "/app/join"];
/**
 * Signed-in app paths, opened as the seeded owner (`e2e/auth.setup.ts`). Local runs only: against a deployed preview
 * there is no throwaway account to sign in with, and the preview's store is not ours to fill.
 */
export const APP_PAGES: string[] = ["/app/start", "/app/onboarding", "/app", "/app/chat", "/app/conversations", "/app/todo", "/app/tasks", "/app/calendar", "/app/files", "/app/brands", "/app/generate", "/app/inspo"];
const LANGS = ["ar", "en"] as const;
const WIDTHS = [1440, 1024, 768, 390, 360];

/**
 * Fails when the page scrolls sideways or a visible element sticks out past either edge. An element inside a parent
 * that clips or scrolls horizontally is that parent's business (its own box is still checked).
 */
export async function noSideways(page: Page) {
  const out = await page.evaluate(() => {
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return true;
      return false;
    };
    return [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || (r.right <= innerWidth + 1 && r.left >= -1)) return false;
        return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !clipped(el);
      })
      .slice(0, 5)
      .map((el) => { const r = el.getBoundingClientRect(); return `<${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 60)}"> ${Math.round(r.left)}..${Math.round(r.right)}`; });
  });
  expect(out, "elements past the viewport edge").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page scrolls sideways").toBe(true);
}

function matrix(paths: string[]) {
  for (const lang of LANGS) {
    for (const width of WIDTHS) {
      for (const path of paths) {
        test(`${lang} ${width} ${path || "/"}`, async ({ page }, info) => {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`/${lang}${path}`);
          await page.waitForLoadState("load");
          await noSideways(page);
          const slug = path ? path.slice(1).replace(/\//g, "-") : "home";
          await page.screenshot({ path: `e2e/.output/reskin/${info.project.name}/${lang}-${width}-${slug}.png`, fullPage: true });
        });
      }
    }
  }
}

matrix(PAGES);

test.describe("signed in", () => {
  test.skip(!!process.env.E2E_BASE_URL, "signed-in pages run against the local build only");
  test.use({ storageState: "e2e/.auth/owner.json" });
  matrix(APP_PAGES);
});
