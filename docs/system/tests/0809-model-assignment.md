# Coverage: only the three current models are called (rules 809, 900)

Status on 2026-10-09 on branch `claude/ai-api-task-assignment-834d4f`: rules 809 and 900 added. The founder asked to use only the latest three models ("use the last 3 models right now only"). Every Claude call moved: Opus 5 to Opus 5.5 (generation, onboarding), Sonnet 5 to Sonnet 5.5 (reviewer, cross-agent review, judge; chat was already on it), Sonnet 5 to Haiku 5.5 (image and video prompt writer, free tools).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 809 | Every model id a call names in `src` is `claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`; each job's model is pinned (`ESTIMATE_MODELS`, `CHAT_MODEL`, the free-tool route); all three have their own rate in `RATES` (`src/lib/usage.ts`), so none is priced as the Opus 5 default | `tests/model-assignment.test.ts` (3 tests) | — |
| 900 | A free tool whose reply has no text (a refusal: Haiku 5.5 has no server-side fallback) answers 502 `failed` and does not count a use in `toolusage:{slug}`; text is returned as before and counted | `tests/model-assignment.test.ts` (2 tests; the first fails without the check) | — |

## What else moved with the rates

Opus 5.5 is 20% cheaper than Opus 5, so `tests/pricing-floor.test.ts` (rule 241) was re-pinned to the new estimates (`docs/system/costs.md` section 3 has them). Three results change behaviour:

- The one-item chat draft exemption (founder decision 2026-09-29) was removed: a one-item draft is $0.0605 per credit, under the $0.0710 ceiling.
- Majed's auto-run (rule 296) may now start `followup_seq` ($0.0653 cold, was $0.0773). Only `article` stays left to Run. The Governance subtitle and the help answer (Arabic and English) no longer say follow-up cadences never start on their own; `tests/handoff-auto.test.ts` pins the new words.
- The prompt-identity hashes of rules 262, 270 and 274 (`tests/cross-review.test.ts`, `tests/handoffs.test.ts`) changed only by the model id: hashed with the ids mapped back, the old values came out unchanged.

## Not pinned

- Output quality of the new models. The golden set (`src/lib/golden.ts`) needs a model key; run it on staging before release.
- Sonnet 5.5's broader safety classifiers on the reviewer and judge: a refusal there already falls back (the reviewer returns the items as they were, the judge throws and scores nothing).

## Reconciled with model routing (PR #298, 2026-10-09)

On the routing branch every model comes from `route(purpose)` (`src/lib/models/route.ts`), so rule 809 is pinned there
instead of by a scan for literals (`tests/model-route-calls.test.ts` forbids model ids outside `route.ts`): every
`route(purpose)` default, every `autoModels()` and `pickModels()` entry, `PRICED_AT`, and the judge for every
`generatedBy` in the catalog are one of the three; a stored pick of a retired model falls back to the default; the
free tools and the prompt writer route to Haiku 5.5, and the tool route sends `route("tool").model`
(`tests/model-assignment.test.ts`). Opus 5 and Sonnet 5 stay in the catalog with `auto` and `pick` false (their rates
price stored usage). Haiku 5.5 is `auto` (it is the default of two purposes) but not pickable, and its `tasks` is empty.

Figures that moved on the routing branch with it (`tests/pricing-floor.test.ts`, `docs/system/costs.md` section 4.2,
rows 813-833 of `tests.md`): the default model's cold exemption is `article` only ($0.0773); Opus 5.5 at x2 in chat has
100% of Automatic's room (Opus 5 had 80%) and the same cliff, 141,396 characters; a batch Sonnet 5.5 generated on a
customer's pick is judged by Haiku 5.5 (the cheapest automatic model no dearer than the default judge).
