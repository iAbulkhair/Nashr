---
name: write-a-browser-test
description: Use when adding or fixing a Playwright end-to-end test in e2e/ for a customer journey, in Arabic or English, desktop or phone.
---

# Write a browser test

End-to-end tests are slow and run in CI only on a ready PR. Write one for a journey a customer walks (sign up, create a workspace, publish, pay), not for logic a unit test covers (write-a-unit-test). Config: `playwright.config.ts`. Coverage notes: `docs/system/tests/2950-e2e.md`.

## How the setup works

- `testDir` is `e2e`. Projects: setup, `chromium-desktop`, and `mobile-safari` (WebKit only when `E2E_WEBKIT=1`). Locale is `en-US`; switch language through the app's own control or the `/ar` path.
- The server is started by `e2e/web-server.ts`: it runs `npm run build:hostinger`, then `next start` on `E2E_PORT` (default 3210) with `APP_ENV=test`, random admin and connect secrets, the memory store and the model mock on. It never reuses a running server, so a stale build cannot hide a failure. `E2E_BASE_URL` points tests at another server.
- `e2e/auth.setup.ts` signs in the seeded owner once and saves the owner state to a gitignored file under the e2e folder (never committed).
- Fixtures: `e2e/fixtures/accounts.ts` (fresh accounts), `app.ts`, `routes.ts`, `workspace.ts`. Use `freshAccount` and `createWorkspace` for anything that changes data, so specs do not share state.
- Signup is limited to 5 per IP per hour. The fixtures simulate an IP per name; keep that, and add a spec that signs up its own accounts to the `testIgnore` list of the `mobile-safari` project in `playwright.config.ts`.
- CI retries twice with two workers. A test that needs a retry to pass is broken.

## Steps

1. Read a neighbouring spec in `e2e/` and the fixtures it uses. Copy its structure.
2. Name the journey in one sentence and test only that. Start from a fresh account unless the spec only reads.
3. Select by role and visible text (`getByRole`, `getByLabel`), not by CSS class. Wait on a result (`expect(...).toBeVisible()`), never on `waitForTimeout`.
4. Test both languages when the journey has copy or layout risk; check right-to-left by asserting the `dir` attribute and a visible element, not pixel positions.
5. Dev codes: with `APP_ENV=test` verification codes come back in the response; read them through the fixture helper. Do not add test shortcuts to the app code.
6. No real network: model, mail and payments are mocked in the test server. Never use real provider keys or the live site.
7. Add the journey to `docs/system/tests/2950-e2e.md` or a new `docs/system/tests/NNNN-slug.md` (add-a-feature, numbering step).

## Run

Locally: `npx playwright test e2e/<spec>.spec.ts --project=chromium-desktop` (first run builds, takes minutes). Debug with `--headed` or `--trace on`. Set up browsers with `npx playwright install chromium` (local-setup).

## Traps

- Running the whole suite to check one spec. Run the one file.
- Pushing to see whether the journey passes in CI. Prove it locally first (fix-a-red-ci-run).
- Hard-coded accounts or waits that depend on machine speed.
- Asserting copy that the founder may reword. Assert structure and one stable phrase at most.
