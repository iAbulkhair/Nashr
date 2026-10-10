# Coverage: an Automatic batch keeps the default judge (rule 903)

Status on 2026-10-10 on PR #298 (model routing), after rule 902. Founder decision: "keep Sonnet judge for Automatic Sonnet batches".

- `route("judge", { generatedBy, task })` returns the default judge (Sonnet 5.5) unless `generatedBy` is the default judge and is not the type's own automatic writer (`automaticFor("generate", task)`, i.e. `TASK_MODELS[task].write`). Then it returns `judgeAlternative` (today Haiku 5.5).
- So an Automatic batch of the 16 types Sonnet 5.5 writes is judged by Sonnet 5.5, as on main before #298. A customer's Sonnet 5.5 pick on one of the 10 types Opus 5.5 writes is judged by Haiku 5.5. An Opus 5.5 batch is judged by Sonnet 5.5.
- A task that is not exactly a task type (prototype names, non-strings) gives no exception: the alternative applies, as before rule 903.
- `judge.ts` passes `task: type` to route(). The estimate still prices the Sonnet 5.5 judge, so the floor (rule 902) is unaffected.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 903 | The judge keeps the default when the batch was written by the type's own automatic writer; only a pick off the writer that equals the default judge moves to the alternative | `tests/model-route.test.ts` (rule 903: 16 Sonnet-written types give Sonnet 5.5, 10 Opus-written types with a Sonnet batch give Haiku 5.5, an Opus batch gives Sonnet 5.5, a bad task gives Haiku 5.5), `tests/model-route-calls.test.ts` (an Automatic article batch is generated and judged on Sonnet 5.5; a Sonnet pick on social is judged on Haiku 5.5 with `{ generatedBy, task }`), `tests/pricing-floor.test.ts` (source pin of the judge call in `judge.ts`) | — |

## Not pinned

- Judge quality per model: Haiku 5.5 as judge of a picked Sonnet batch is not measured on the golden set.
