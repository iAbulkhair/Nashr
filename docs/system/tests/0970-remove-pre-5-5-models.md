# Coverage: the 5.5 generation only, and the catalog as the only rate table (rules 970-972)

Status on 2026-10-10 on branch `claude/anthropic-token-cost-calculation-3ec086`: every rule is written. The founder asked
to stop using the models before 5.5 after reconciling the Anthropic Console token export of 2026-09-11 to 2026-10-10
with the credits spent ($34.50 spent, $34.54 at list prices). Production (`origin/production`) already called only 5.5
models; this removes Opus 5 and Sonnet 5 from the catalog and the old `RATES` table from `src/lib/usage.ts` (the
contract step that rule 679's expand release for the catalog left open). No stored value is a rate, so no data
conversion runs. Rules 960-969 belong to the metering-gaps branch.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 970 | The model catalog lists only `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`; `modelById` answers `undefined` for `claude-opus-5` and `claude-sonnet-5`. | Yes | Written: `tests/model-catalog.test.ts` "the real catalog" |
| 971 | A stored chat or generation pick of a removed model is refused as `unknown` and the default runs (a conversation or brand saved with Opus 5 keeps working). | Yes | Written: `tests/model-route.test.ts` (pick rules), `tests/model-assignment.test.ts` (retired pick) |
| 972 | `costUsd` and `hasRate` read only the catalog. `hasRate` is false for any other id; `costUsd` prices any other id (a removed model, a dated id, `constructor`) at the highest catalog rate of each bucket, never below the dearest catalog model, and `meter` counts it under `other`. No file under `src` keeps a second rate table. | Yes | Written: `tests/model-catalog.test.ts` "costUsd and hasRate read the catalog first", `tests/usage-model.test.ts` "the model key is never a free string", `tests/model-route-calls.test.ts` (no `RATES` entry allowed) |

Fixtures in the other tests that named `claude-opus-5` or `claude-sonnet-5` as a working model now name the 5.5 model,
and their dollar figures moved to Opus 5.5's $4/$20 (cache read $0.20, write $5): for example 1,000 in + 1,000 out is
$0.024, not $0.03. Sonnet 5.5 has the same rates Sonnet 5 had, so those figures did not move.
