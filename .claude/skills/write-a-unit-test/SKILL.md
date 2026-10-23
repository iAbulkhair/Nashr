---
name: write-a-unit-test
description: Use when adding a vitest test in tests/ for a rule, route, library function or isolation case, with rule-numbered names and the shared helpers.
---

# Write a unit test

Every rule you touch gets a test (CLAUDE.md). Config: `vitest.config.mts` runs `tests/**/*.test.ts` in the node environment with `tests/helpers/setup.ts`, which mocks `next/headers` (cookies and headers) and `after`. Tests run on the in-memory store with no network and the model mock.

## Helpers (in `tests/helpers`)

- `session.ts`: `newUser`, `newOpaqueUser`, `newMember`, `signIn`, `signOut`, `adminSignIn`, `json`, `params`, `settle`, `withHeaders`, `PERSONS`. `TEST_PERSONS=legacy` switches the account shape; CI runs both on a ready PR.
- `rounds.ts` (`trackRounds`) counts Redis round trips; `model.ts` (`claudeOn`) mocks the model; `media.ts` for media (add-a-model-or-media-provider); `passkeys.ts`, `staff.ts`, `coverage.ts` for their areas.

## Steps

1. Find the nearest existing test (`grep -l` the function or route name in `tests/`) and copy its setup. Name the new file after the thing tested: `tests/<topic>.test.ts`.
2. Header comment: the rules covered and the coverage file, e.g. `docs/system/tests/3150-agent-skills.md`.
3. Name tests so the rule number is searchable: `describe("signup limits (rule 242)", ...)`. A test without a rule is allowed for plain behaviour, but a rule always gets one.
4. Route tests import the handlers: `import * as route from "@/app/api/<area>/route"`, build a request with `json(url, method, body, { "x-forwarded-for": ip })`, sign in with `signIn` (a fresh IP per test avoids rate-limit bleed), call `route.POST(req, params({...}))` and assert status and body.
5. For every route add: signed out gives 401, wrong role gives 403, bad body gives the documented error, and a second account asking for the first account's record gets the same answer as for a missing one (add-an-api-route, add-a-workspace-scoped-feature).
6. Time and randomness: pass a clock or id into the function, or use vitest fake timers. No `Date.now()` races. No real network; `fetch` is stubbed per test.
7. Do not mock `src/lib/db.ts`; use the memory store so key mistakes show up. Read keys through the `src/lib/keys.ts` builders.
8. Add or update the coverage file `docs/system/tests/NNNN-slug.md`: a table with `#`, `Rule`, `Verified today` and `First test to write`. A new change adds its own file; it never appends rows to `docs/system/tests.md` (rule 788). Pick rule numbers free on `origin/main` (`git ls-tree --name-only origin/main docs/system/tests/`) and in open PR titles.

## Run

`npx vitest run tests/<file>.test.ts`, then `TEST_PERSONS=legacy npx vitest run tests/<file>.test.ts`, then `npm run check`.

## Traps

- Tests that pass only in isolation because they share the memory store or a rate-limit bucket. Use new users and IPs per test.
- Asserting a message string that the founder may reword. Assert the code.
- A test that reads the real clock or the live site.
- Weakening a pairing test (docs vs code, lint ratchet) to make a change pass (fix-a-red-ci-run).
