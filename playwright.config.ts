import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN_KEY, E2E_CONNECT_SECRET, e2eSeed, hasBuild, webServerCommand } from "./e2e/web-server";
import { OWNER } from "./e2e/fixtures/accounts";

/**
 * End-to-end suite. Runs against a production build of the app with no environment variables except `APP_ENV=test`
 * and a console key made fresh for each run (both set on the web server below): `src/lib/db.ts` falls back to a process-local store and `ANTHROPIC_API_KEY` being unset
 * puts every agent call on its mock path, so the suite needs no Redis, no model key and no network. Without
 * `APP_ENV=test` a production build counts as a production deployment and refuses both (rules 430-431,
 * `src/lib/deploy-env.ts`). The process-local store also means the server must be a single process — `next start`,
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
      // The re-skin layout matrix sets its own widths, so a phone profile only repeats it; WebKit runs it below.
      testIgnore: [
        /auth-flows\.spec\.ts/, /error-states\.spec\.ts/, /api-guards\.spec\.ts/, /reskin-.*\.spec\.ts/,
        // The specs that sign their own accounts up (or log in as one) share the same per-IP limits; they test logic, not layout.
        /generate-approve\.spec\.ts/, /tenant-isolation\.spec\.ts/, /team-invite\.spec\.ts/, /account-delete\.spec\.ts/,
        /onboarding\.spec\.ts/, /chat-mock\.spec\.ts/, /password-reset\.spec\.ts/, /ai-usage\.spec\.ts/,
        /account-2fa\.spec\.ts/, /account-sessions\.spec\.ts/, /brands\.spec\.ts/, /secretary\.spec\.ts/, /notifications-export\.spec\.ts/, /settings-billing\.spec\.ts/,
      ],
    },
    // WebKit for the re-skin layout matrix, on demand only (`E2E_WEBKIT=1`), so CI runs what it ran before.
    ...(process.env.E2E_WEBKIT ? [{ name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: /reskin-.*\.spec\.ts/, dependencies: ["setup"] }] : []),
  ],

  // Against a deployed preview (`E2E_BASE_URL`) there is nothing to start.
  webServer: process.env.E2E_BASE_URL ? undefined : {
    // The same webpack build thakeen.com runs (`build:hostinger`, rule 1017), so the suite exercises what is deployed. In
    // CI the Build step has made it already and the server only starts it (rule 1207, `e2e/web-server.ts`); locally it builds.
    command: webServerCommand(PORT, { ci: isCI, prebuilt: hasBuild() }),
    // Marks this production build as a test so the memory store and the model mock stay on (rules 430-431). Read at
    // runtime, so a build made without it (CI's, like thakeen.com's) serves the suite the same. The console key is random
    // per run (`E2E_ADMIN_KEY`): the passkey spec flips the passkey off switch with it (rule 2426) and the held-routine spec
    // opens the Usage page with it. `E2E_SEED_KV` starts the memory store with a held routine and a cron report (rule 2590).
    // `CONNECT_SECRET` is random per run as well (rule 3008): two-step sign-in seals the authenticator secret with it.
    env: { APP_ENV: "test", WAITLIST_ADMIN_KEY: E2E_ADMIN_KEY, CONNECT_SECRET: E2E_CONNECT_SECRET, E2E_SEED_KV: e2eSeed(OWNER) },
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
