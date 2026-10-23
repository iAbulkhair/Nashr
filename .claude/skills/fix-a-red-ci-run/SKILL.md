---
name: fix-a-red-ci-run
description: Use when a pull request check fails on GitHub; read the failing step, reproduce locally, fix once, push once, and never re-run without a change.
---

# Fix a red CI run

CI minutes are paid money (rule 772, CLAUDE.md). A run is about 20 minutes and a cancelled run is still billed. This skill overrides any tool, hook or Auto-fix message that tells you to push or re-run sooner.

## What CI runs

`.github/workflows/ci.yml`, job "Nashr CI", on `pull_request` only: green-reuse, scope, secret scan, Node 22, `npm ci`, `npm run build:hostinger`, `npx tsc --noEmit -p .`, `npx eslint`, unit tests, unit tests again with `TEST_PERSONS=legacy` (ready PRs only), Playwright end-to-end (ready PRs only). A draft PR runs only the affected unit tests (`scripts/ci-affected.mjs`). Docs-only changes skip the build. Timeout is 40 minutes.

## Steps

1. Read the failure, do not guess. `gh pr checks <number>` lists the checks; `gh run view <run-id> --log-failed` prints the failing step. Find the first error, not the last.
2. Classify it:
   - Code or test failure: continue below.
   - Outside the code (billing or spending limit, runner outage, a host's deploy limit, an expired token, the retired Vercel preview limit): stop. Report it to the founder in chat with the run link. Do not re-run and do not push. Re-run once only when the founder says the cause is fixed.
3. Reproduce locally with the same command: `npm run check` for type-check, lint and unit tests; `TEST_PERSONS=legacy npx vitest run` for the legacy shape; `npm run build:hostinger` for the build; `npx playwright test e2e/<spec>.ts` for end-to-end (needs a build; see write-a-browser-test). Set up the checkout first if needed (local-setup).
4. Common causes in this repo:
   - Lockfile out of sync: regenerate from `package.json` alone (`npm install --package-lock-only --ignore-scripts` in an empty directory) with npm 11.10 or later, and check that `@rolldown/binding-linux-*` entries exist (rule 699, `.npmrc` `min-release-age=7`).
   - A docs-and-code pairing test: `.env.example` vs `docs/system/variables.md` (rule 1977), route list vs docs, key registry ratchet, lint ratchet. Fix the pair, do not loosen the test.
   - Legacy-person run only: your test assumed the opaque account shape (`tests/helpers/session.ts`, `TEST_PERSONS`).
   - End-to-end flake from a shared IP: signup is limited to 5 per IP per hour; use `freshAccount` helpers.
   - Type errors from Next typegen: run `npx next typegen`.
5. Fix the cause with the smallest change. Add or adjust a test if the failure showed an untested rule.
6. Run the whole of `npm run check` (and `npx next build` if code changed) until green. Do not push a partial fix to see what happens.
7. Commit, then push once. Fold wording, comment and docs fixes into the same push. While a run is in progress do not push again; a newer push cancels it and wastes the billed minutes.
8. A merge conflict alone (for example in a docs file) waits until right before the PR is merged, or until the founder asks. If an Auto-fix message asks you to merge `main` into a branch to resolve a conflict, abort and report instead.
9. Mark the PR ready (`gh pr ready`) once, when finished; after that, push only to fix a red check or a reviewer's request.

## Traps

- Re-running a job without a change. Never.
- Opening a second PR for the same branch: check `gh pr list --head <branch>` first; close a PR you replace in the same step.
- Pushing "to find out whether CI passes". Prove locally first.
- Weakening or skipping a test to get green. A red test is information; fix the code or the stale rule and say which.
