# Coverage: metering every call Anthropic bills (rules 980-986)

Status on 2026-10-10 on branch `claude/happy-gould-4c332b` (no PR). Rules 960-973 are taken by branch `claude/uiux-phase0`, so this change starts at 980. Flows section 61.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 980 | Every model call is a stream wrapped by `metered()` (`src/lib/metered.ts`): no `messages.create` in `src`, each file with `messages.stream(` has at least as many `metered(` calls, and only `metered.ts` awaits `.finalMessage(`. Calls bounded only by the SDK `timeout` before (judge, cross-review, image prompts) also carry an `until()` signal | `tests/meter-billed.test.ts` (a source scan with comments stripped), `tests/cross-review.test.ts` and `tests/media-prompts.test.ts` (the options carry a signal) | — |
| 981 | A reply with `usage.iterations` (server-side fallback) is metered per iteration at its own model, a model-less one at the requested model, summed per model (`billedParts`); the account, kind, agent and provider count one call, each model's `_all` counter its own attempt, USD the sum at each model's rate (`meterBilled`). Without iterations it is `meter()` as before | `tests/meter-billed.test.ts` (`billedParts` cases, `meterBilled` counters, `generate()` with a fallback reply) | — |
| 982 | A stream that fails after its first event is metered from `currentMessage` (or the last `receivedMessages` when the snapshot was cleared): input and cache exact, output raised to what had streamed; the same error is rethrown | `tests/meter-billed.test.ts` | — |
| 983 | The streamed-output estimate counts text, thinking and `tool_use` input at about 4 ASCII or 2 other characters a token, ignores other blocks, and never lowers a reported count | `tests/meter-billed.test.ts` (`streamedTokens`, `partialUsage`) | — |
| 984 | A failure before the first event (no snapshot) meters nothing | `tests/meter-billed.test.ts` | — |
| 985 | A chat turn cut by the request deadline is metered as `chat` for its agent with what it had streamed, and the reply is still `OUT_OF_TIME_REPLY` | `tests/meter-billed.test.ts` (fake timers, a hanging stream) | — |
| 986 | The judge's call carries an `until()` signal bounded by `MODEL_BUDGET.JUDGE_MS`; the SDK `timeout` stays as the header bound | `tests/meter-billed.test.ts` | — |

## Notes

- Existing test mocks answered `messages.create`; they now answer `messages.stream` with a `finalMessage` that calls the old `create` mock, so their assertions did not move.
- No stored shape changes: the same `usage:` counters get more increments (rule 679 not involved).

## Not pinned

- Whether Anthropic bills a timeout before the response headers, or a mid-stream `overloaded_error`, exactly as metered here. The code assumes: nothing before `message_start`, everything up to the cut after it. Check against the Anthropic Console a week after release.
- The output estimate is a lower bound: thinking the API does not show (`redacted_thinking`, summarised thinking) is billed and not counted.
- The two API keys in the Console (Vercel and Hostinger possibly running the same crons) are an ops question for the founder, not this change.
