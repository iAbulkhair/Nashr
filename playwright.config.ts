import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite. Runs against a production build of the app with NO environment variables: `src/lib/db.ts` falls back
 * to a process-local store and `ANTHROPIC_API_KEY` being unset puts every agent call on its mock path, so the suite
 * needs no Redis, no model key and no network. That also means the server must be a single process — `next start`,
 * not a cluster — or the in-memory store would differ between requests.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
// `localhost`, not `127.0.0.1`: the session cookie is issued with `Secure` (correct — production is HTTPS), and only a
// "potentially trustworthy origin" receives a Secure cookie over plain HTTP. Both spellings qualify per the spec, but
// Playwright's request client applies the exception to the hostname, not the literal address.
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.output",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never", outputFolder: "e2e/.report" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    // The proxy (src/proxy.ts) picks the language from Accept-Language when no cookie is set. Pinning it keeps the
    // redirect from "/" deterministic instead of depending on whatever locale the runner happens to have.
    locale: "en-US",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
  },

  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      dependencies: ["setup"],
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 14 Pro"], viewport: { width: 390, height: 844 } },
      dependencies: ["setup"],
      // Layout-sensitive specs only. The auth and error-state specs drive real sign-ups and log-ins, and the app
      // throttles those per IP (five sign-ups an hour) and per account — limits shared by every project, since they
      // all hit one server from one address. Running them on a second browser in parallel makes the suite compete
      // with itself and fail on the product's own rate limiter rather than on a defect. They exercise logic, not
      // layout, so chromium covers them; everything that could break at 390px still runs here.
      testIgnore: [/auth-flows\.spec\.ts/, /error-states\.spec\.ts/, /api-guards\.spec\.ts/],
    },
  ],

  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: baseURL,
    // Never reuse. The rate limiters (signup five per IP per hour, forgot three per address per fifteen minutes, login
    // eight per account) live in the same process-local store as the data, so a server left running from an earlier run
    // carries counters that make the auth specs depend on how many times the suite has already run. A fresh process per
    // run is what makes "green twice in a row" mean anything.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
