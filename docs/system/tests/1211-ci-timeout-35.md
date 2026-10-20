# Coverage: the CI job cap is 35 minutes (rule 1211)

Status on 2026-10-12 on branch `claude/uiux-phase5` (PR #331), on the founder's choice ("Raise cap to 35 min"). Flows section 62, item 6. Follows rule 1207 (#334, build once).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1211 | The one job in `.github/workflows/ci.yml` has `timeout-minutes: 35`. With one build a passing run takes about 24 minutes (Build about 2, unit tests about 7, end-to-end suite about 14), so 25 cancelled runs that were about to pass | `tests/ci-build-once.test.ts` (rule 1207 block: the workflow has exactly one `timeout-minutes: 35`) | — |

## Notes

- Evidence: PR #330 run 38230153064 (unit tests 09:32:46-09:39:49, suite 09:40:30-09:53:39) passed at about 23.5 minutes; PR #331 run 38233579513 was cancelled at 25 minutes 13 m 39 s into the suite with 1,042 tests passed.
- Cost: a passing run costs the same minutes; a hung run can cost up to 10 more before it is stopped.
- No stored shape, route, permission or environment variable changes.
- Raised to 40 minutes on 2026-10-20 by rule 2511 (`docs/system/tests/2510-ci-legacy-persons.md`), for the unit tests' second pass in production's person shape on ready pull requests; `tests/ci-build-once.test.ts` now pins 40.
