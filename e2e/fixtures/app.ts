import { test as base, expect, type ConsoleMessage, type Locator, type Page, type Request, type Response } from "@playwright/test";

/**
 * The shared fixture. Every test gets a page already watching for the two failure classes the suite treats as automatic
 * failures — an error in the browser console, and a request that came back 4xx/5xx — so a route spec does not have to
 * remember to assert them. A test that legitimately expects one opts out with `test.use({ allowConsole: [...] })`.
 */

/** Noise no application change can remove, so it must not fail a test. Keep this list short and each entry justified. */
const IGNORED_CONSOLE = [
  // An aborted navigation logs this while Next is still streaming the RSC payload; nothing is wrong.
  /Failed to fetch RSC payload/i,
  // Safari's note on the report-only CSP (rule 1341): it reports only to the console by design, so it names no
  // `report-to`. Only this exact note is ignored; a real violation still fails. Drop it when the policy gets a report
  // endpoint or moves into the enforced header.
  /^The Content Security Policy '.*' was delivered in report-only mode, but does not specify a 'report-to'; the policy will have no effect\./,
];

export type Failures = { console: string[]; http: string[] };

type Fixtures = {
  failures: Failures;
  /** Console errors this test expects, as regexes. */
  allowConsole: RegExp[];
  /** Responses this test expects, matched against `${status} ${url}`. */
  allowHttp: RegExp[];
};

export const test = base.extend<Fixtures>({
  allowConsole: [[], { option: true }],
  allowHttp: [[], { option: true }],

  // The second argument is Playwright's "provide the fixture value and then tear it down" callback. It is passed
  // positionally, so it is named `runTest` rather than the conventional `use`: React's lint rules treat a call to
  // anything named `use` as a hook call and reject it outside a component.
  failures: async ({ page, allowConsole, allowHttp }, runTest) => {
    const failures: Failures = { console: [], http: [] };

    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
      if (allowConsole.some((r) => r.test(text))) return;
      failures.console.push(text);
    };
    const onPageError = (err: Error) => {
      const text = `uncaught: ${err.message}`;
      if (allowConsole.some((r) => r.test(text))) return;
      failures.console.push(text);
    };
    const onResponse = (res: Response) => {
      if (res.status() < 400) return;
      const line = `${res.status()} ${res.url()}`;
      if (allowHttp.some((r) => r.test(line))) return;
      failures.http.push(line);
    };
    const onRequestFailed = (req: Request) => {
      const error = req.failure()?.errorText ?? "unknown";
      // Next prefetches the RSC payload of every link in the viewport. Those requests are cancelled when the page
      // navigates or the test ends, which surfaces as ERR_ABORTED on a `_rsc=` URL. It is the framework working as
      // designed, not a request the application failed to make.
      if (error === "net::ERR_ABORTED" && req.url().includes("_rsc=")) return;
      const line = `failed ${req.url()} (${error})`;
      if (allowHttp.some((r) => r.test(line))) return;
      failures.http.push(line);
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);

    await runTest(failures);

    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);

    expect(failures.console, "browser console errors during this test").toEqual([]);
    expect(failures.http, "failed network requests during this test").toEqual([]);
  },
});

export { expect };

/** Open a route and return the top-level response, so a spec can assert the status and the final URL after redirects. */
export async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  if (!res) throw new Error(`no response for ${path}`);
  return res;
}

/**
 * Type into a React-controlled field, but only once React owns it.
 *
 * `page.goto(..., { waitUntil: "domcontentloaded" })` returns while the client bundle may still be evaluating. A
 * `fill()` in that window writes straight to the DOM node; React then hydrates, finds its own state still empty and
 * puts the input back to "". The form submits blank and the app answers "Invalid email." — correctly, because that
 * is what its state held. A person cannot type faster than hydration, so the race is the harness's, not the
 * product's. React tags every node it has attached to with a `__reactFiber$…` key, which is the signal to wait for.
 */
export async function fillWhenReady(field: Locator, value: string) {
  await field.waitFor({ state: "visible" });
  await expect
    .poll(() => field.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"))), {
      message: "React never hydrated this field",
    })
    .toBe(true);
  await field.fill(value);
  // The value has to survive the round trip through React's state, not merely sit in the DOM.
  await expect(field).toHaveValue(value);
}

/** The document direction the layout must set: Arabic is right-to-left, English is left-to-right. */
export const dirFor = (lang: Lang) => (lang === "ar" ? "rtl" : "ltr");

export type Lang = "ar" | "en";
export const LANGS: Lang[] = ["ar", "en"];

/**
 * The error message a form shows. Scoped to the form on purpose: Next renders its own `role="alert"` live region
 * (`#__next-route-announcer__`) on every page, so an unscoped `getByRole("alert")` matches two nodes and fails strict
 * mode rather than finding the application's message.
 */
export const formAlert = (page: Page) => page.locator("form").getByRole("alert");
