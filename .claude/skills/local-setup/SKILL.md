---
name: local-setup
description: Use when setting up a fresh checkout or worktree of Thakeen to run the app, the checks and the build locally.
---

# Local setup

Stack: Next.js 16 (app router), React, TypeScript, Upstash Redis through `src/lib/db.ts`, vitest, Playwright. The README is the stock create-next-app text; this skill is the real procedure. Next.js 16 has breaking changes: read the matching guide in `node_modules/next/dist/docs/` before writing page or route code (`AGENTS.md`).

## Steps

1. Use npm 11.10 or later. `.npmrc` sets `min-release-age=7` (rule 699): a package younger than a week is never resolved.
2. Install in the checkout (a new worktree has no `node_modules`; `tsc` and the tests need their own):
   `npm ci --cache "$TMPDIR/npm-cache"`. The cache flag avoids a permission error on the default cache inside the sandbox.
3. Environment: copy names from `.env.example` into a local, uncommitted `.env.local` only for what you need. No values in chat, in commits or in docs. Without Redis credentials outside production the app uses the in-memory store (`src/lib/db.ts`); without the mail variables, mail goes to the console provider (`src/lib/mail-provider.ts`); the model is mocked in tests.
4. Run the app: `npm run dev` (port 3000; the preview entry is `nashr-dev` in `.claude/launch.json`). Open `/ar` and `/en`.
5. Checks: `npm run check` runs `tsc --noEmit -p .`, `eslint` and `vitest run`. One test file: `npx vitest run tests/<name>.test.ts`. Legacy account shape: `TEST_PERSONS=legacy npx vitest run`.
6. Build: `npx next build`. If Turbopack hangs on its worker pool locally, use `npm run build:hostinger` (`next build --webpack`), which is also what CI and Hostinger run.
7. Browser tests: `npx playwright test` builds and starts its own server on `E2E_PORT` (default 3210) with the memory store and model mock on (write-a-browser-test). Install browsers once with `npx playwright install chromium`.
8. Scripts under `scripts/` that are TypeScript run with `npx --no-install jiti scripts/<name>.ts`.

## Known snags

- `npx next typegen` fixes missing `PageProps` and route types after a fresh install.
- macOS has no `timeout`. Use `perl -e 'alarm shift; exec @ARGV' 900 <command>` for a limit.
- Inside the agent sandbox, write temp files under `$TMPDIR`, and `gh` and the network may need to run outside it.
- `APP_ENV=test` makes the app return dev codes in responses. Use it only locally and in the end-to-end server; never on staging or live (`src/lib/deploy-env.ts`).
- A lockfile changed by `npm install` in an existing `node_modules` may lose optional platform bindings (`@rolldown/binding-linux-*`); regenerate it from `package.json` alone in an empty directory (change in dependencies is a lockfile task, see fix-a-red-ci-run).
- Never commit `node_modules`, `.next`, `.env*` files with values, `.smoke.local` or Playwright auth state (a gitignored folder under e2e).

## Before any commit

`npm run check` and `npx next build` pass. Commit often; push once per finished step. Work in progress goes to a branch with no PR (CLAUDE.md, rule 772).
