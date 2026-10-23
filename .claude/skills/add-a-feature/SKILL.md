---
name: add-a-feature
description: Use when adding a whole product feature to Thakeen (page, API, stored data, copy, docs, tests, rule numbers); it chains the narrower skills in the right order.
---

# Add a feature

Thakeen is one Next.js 16 app (app router), Upstash Redis through `src/lib/db.ts`, our own auth, no ORM and no RPC layer. A feature is a few files in four places: `src/lib` (logic and keys), `src/app/api` (route handlers), `src/app/[lang]/app` (pages) and `src/components`. Next.js 16 differs from older versions: read the matching guide in `node_modules/next/dist/docs/` before writing page or route code (`AGENTS.md`).

## Steps

1. Read `docs/system/architecture.md`, `flows.md`, `permissions.md` and `variables.md` for the area you touch. Check that the idea does not break `PRODUCT.md` (approval-first, no invented numbers, customers or logos, Arabic and English at parity).
2. Work on a branch with no pull request (a branch without a PR runs no CI). Never work on `main` or `production`.
3. Decide who owns the data and write the keys and library first: add-a-workspace-scoped-feature. If it changes a shape that already exists in Redis, also follow change-a-stored-shape.
4. Add the routes: add-an-api-route. Spending credits, publishing and brand changes are checked in code (`src/lib/credits.ts`, `src/lib/governance.ts`, `src/lib/roles.ts`), never only in a prompt. Crawled text, catalogs, uploads and connector data are untrusted input.
5. Add the page under `src/app/[lang]/app/b/[brand]/<section>/page.tsx` (brand level) or `src/app/[lang]/app/<section>/page.tsx` (account level), with `export const generateMetadata = appScreenMeta("<screen>")` from `src/lib/screen-titles.ts` (add the screen to `APP_SCREENS` and both name maps). Add a sidebar entry in `src/components/app/Sidebar.tsx`. Build UI from `src/components/ui` (add-a-ui-component).
6. Add the words in both languages (add-arabic-and-english-copy). Every screen and message must exist in Arabic and English.
7. Notifications and mail, if any: add-a-notification, add-or-edit-an-email.
8. Update docs in the same commit: `docs/system/architecture.md` (route and key rows), `flows.md` (a numbered section with a "Releases" line saying expand, contract or none), `permissions.md`, and `variables.md` plus `.env.example` if you read a new environment variable (release-and-env-vars).
9. Number the rules. Take a free block, check `git ls-tree --name-only origin/main docs/system/tests/` and `gh pr list --state open` titles first so no other branch uses it. Add `docs/system/tests/NNNN-slug.md` (never append to `docs/system/tests.md`, rule 788). Format: see `docs/system/tests/3030-tenant-review.md`.
10. Tests for every rule you touch: write-a-unit-test, and a browser journey if a customer flow changed (write-a-browser-test).
11. Run `npm run check` and `npx next build` (local-setup). Fix everything locally. Commit as often as you like.
12. Push once, when the step is finished. Open the PR as a draft (`gh pr create --draft`) after `gh pr list --head <branch>` shows none. Mark it ready once, when finished (fix-a-red-ci-run, release-and-env-vars).

## Done when

The feature works in Arabic (RTL) and English, a second account cannot see or change it, docs and the rule file are in the commit, `npm run check` and `npx next build` pass, and the PR description names the release step (expand, contract or none).

## Traps

- Starting with the page. Write keys, library and tests for isolation first.
- Reusing another feature's rule numbers or appending rows to `docs/system/tests.md`.
- Pushing to see whether CI passes. CI minutes are paid money (CLAUDE.md): prove locally, push once per finished step.
- A feature flag read from a new environment variable with no entry in `docs/system/variables.md`: `tests/margin-integrations.test.ts` and the `.env.example` test fail.
