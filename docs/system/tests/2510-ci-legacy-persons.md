# Coverage: CI runs the unit tests in both person shapes (rules 2510-2511)

Status on 2026-10-20 on branch `claude/ci-legacy-persons`, from the integration check of `main` after #402, #403 and #404 (#407). Flows section 62 item 6a. Rules 2512-2519 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2510 | On a ready pull request `.github/workflows/ci.yml` runs `npx vitest run` a second time with `TEST_PERSONS=legacy` (step "Unit tests (production person shape)", `if: steps.scope.outputs.e2e == 'true'`), after the first pass and before the end-to-end suite; nothing else sets `TEST_PERSONS`, so the first pass keeps the default `p_` shape | `tests/ci-legacy-persons.test.ts` ("rule 2510") | — |
| 2511 | The job's cap is 40 minutes (was 35, rule 1211): a passing ready run takes about 31 | `tests/ci-legacy-persons.test.ts` ("rule 2511"), `tests/ci-build-once.test.ts` (rule 1211 block) | — |

## Notes

- Why: production holds only legacy persons until multi-workspace M2, and CI ran only the `p_` shape. The 2026-10-20 check ran the whole suite with `TEST_PERSONS=legacy` by hand (346 files, 8989 tests, all green).
- Cost: about 7 more minutes on each ready run; a draft run is unchanged.
- No stored shape, route, permission or environment variable of the app changes. `TEST_PERSONS` is read by the test helper only.
