# Coverage: one clock reading per model deadline (rule 1206)

Status on 2026-10-11 on branch `claude/r1-release-prep` (PR #322). This fixes a flaky CI failure (run 38160469570): `tests/media-prompts.test.ts` expected `timeout: 20000` and got `19999`. The code came from main (#318, rules 980-986), not from R1.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1206 | A deadline built from a budget reads the clock once and passes that reading to `until()` as `now` (`const now = Date.now(); until(now + X, { now })`), so the per-attempt timeout equals the budget exactly. This covers the judge (`src/lib/judge.ts`, `MODEL_BUDGET.JUDGE_MS`), the cross-review (`src/lib/noor.ts`, `CROSS_REVIEW_TIMEOUT_MS`) and the media prompts (`src/lib/media/prompts.ts`, `PROMPT_MAX_MS` or the time left). No file in `src` calls `until(Date.now() ...)` | `tests/deadline-clock.test.ts` (`until` with a clock that ticks 1 ms per read, and a source scan with comments stripped), `tests/media-prompts.test.ts` (exactly 20000 and 5000 under the ticking clock), `tests/meter-billed.test.ts` (the judge's timeout is exactly `JUDGE_MS`; it was `<=`) | — |

## Notes

- No behaviour change beyond the off-by-one: the abort timer and the timeout start from the same reading.
- No stored shape changes (rule 679 not involved).

## Not pinned

- The cross-review's exact 45 s has no test of its own under a ticking clock. The source scan covers its call site, and `tests/cross-review.test.ts` still expects exactly `45_000`.
