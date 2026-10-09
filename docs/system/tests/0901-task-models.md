# Coverage: each task type has its own writer and reviewer (rule 901)

Status on 2026-10-09 on branch `claude/ai-api-task-assignment-834d4f` (PR #308, after rules 809 and 900): rule 901 added. The founder asked which tasks really need Opus and approved preparing the split on the branch. `TASK_MODELS` in `src/lib/task-models.ts` names the writer and the reviewer of every task type:

- Opus 5.5 writes 10 types: social, ads, pricing_review, unit_economics, cash_forecast, gtm_plan, board_deck, strategy_review, okrs, decision_memo.
- Sonnet 5.5 writes the other 16 and reviews all 26.

`generate` and `critique` (`src/lib/noor.ts`) and `estimateBatch` (`src/lib/task-costs.ts`) all read the same table. The cross-agent review keeps `REVIEW_MODEL` (Sonnet 5.5). Onboarding stays on Opus 5.5.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 901 | Every task type has a writer and a reviewer in `TASK_MODELS`, each one of the three current models; the ten Opus types and the Sonnet reviewer are pinned; `generate` streams with the type's writer and `critique` calls the type's reviewer; the floor test prices each type at the models it calls | `tests/model-assignment.test.ts` (4 tests; the `generate(article)` case fails when the writer is hard-coded to Opus), `tests/pricing-floor.test.ts` ("the estimates price the models the code calls") | — |

## What else moved

- Every type keeps the floor with room: the dearest cold types are `unit_economics` and `decision_memo` at $0.0515 per credit, 72% of the ceiling. `tests/pricing-floor.test.ts` was re-pinned (`docs/system/costs.md` section 3). The price-cut and credit-count checks that keep it non-vacuous moved to Business at 549 SAR and 2,700 credits.
- The phase-1 repricing (rule 241) stays, though the old prices would now keep the floor; lowering them is a pricing decision.
- Majed's auto-run (rule 296) may now start `article` ($0.0482 cold): no handoff type is left to Run. The Governance subtitle and the help answer (Arabic and English) no longer name SEO articles. `tests/handoff-auto.test.ts` tests the floor guard against a lowered ceiling (`maxCostPerCreditUsd` mocked while `floor.tight` is set), so the guard stays tested with no type over the real one.
- The full-brief handoff article that was 0.6% over the ceiling on a hit (costs.md section 5) is now about $0.041 per credit.

## Not pinned

- Output quality per type. Run the golden set (`src/lib/golden.ts`) on staging for this commit and for the all-Opus commit before it (c8fbce6), and compare per type. A Sonnet type that loses quality moves back to Opus, or gets an Opus reviewer, by changing one cell.
- A Sonnet 5.5 writer reviewed by Sonnet 5.5: a reviewer from the same model may miss what the writer missed. The golden set's judge scores show whether it matters.
- PR #298 (model routing): its `route("generate")` has one default for every type, and `tests/model-route-calls.test.ts` there forbids any other file naming a model. The second of the two to merge moves `TASK_MODELS` behind `route()`, as a per-type default.
