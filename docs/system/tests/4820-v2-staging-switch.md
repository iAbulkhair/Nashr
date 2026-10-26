# Coverage: the v2 staging switch, credits on the run log, the golden self-check mode (rules 4820-4834, 4835-4839 reserved)

Status on 2026-10-26 on branch `claude/v2-staging-switch-on-f596ee` (after #483, 886f9273). Founder decisions of 2026-10-26: method A for staging, `SEARCH_CREDITS` stays 1 credit (no code change), the charge step on the run log, and a golden self-check mode. Flow in `flows.md` section 141; the variable in `variables.md` section 5f. Release step: **expand** (new optional variable `V2_STAGING_FLAGS`, optional field `Run.credits`, optional fields `GoldenRun.selfCheck` and `GoldenResult.selfCheck`). No flag value changes: live stays off.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4820 | `V2_STAGING_FLAGS` is read only when `APP_ENV` is exactly `staging`; unset, `production`, another case or spacing, the list is ignored and every flag follows its code value (all off) | yes | `tests/v2-staging-switch.test.ts` (rule 4820 block) |
| 4821 | Names are trimmed and case-blind; only the nine known names count; `GATEWAY_LOG` gives the gateway `log`, never `enforce`; a value or an unknown name is ignored | yes | `tests/v2-staging-switch.test.ts` (rule 4821 block) |
| 4822 | Read at call time; a flag released in code stays on and the list cannot change it; the judge's web-claim rule reads `RESEARCH` once at server start (a save in hPanel restarts) | yes | `tests/v2-staging-switch.test.ts` (rule 4822 block) |
| 4823 | Only `v2-switch.ts` reads the flag values (`gateway.ts` imports the type only); the variable is read in one place after the staging check, never from a request; it is named in `variables.md` | yes (source) | `tests/v2-staging-switch.test.ts` (rule 4823 block) |
| 4824 | Every former reader asks `v2On` / `gatewayMode`; the existing v2 tests pin each guard in its new form | yes (source) | `tests/v2-compaction.test.ts`, `tests/v2-memory.test.ts`, `tests/v2-context-meter.test.ts`, `tests/v2-plans.test.ts`, `tests/v2-self-check.test.ts`, `tests/v2-work-view.test.ts` |
| 4825 | A charge and a refund inside a run are recorded in order in `Run.credits`, never in `events`; `replay` sums them | yes | `tests/v2-staging-switch.test.ts` (rules 4825-4827 block) |
| 4826 | A refused charge, a reused `chargeOnce` hold, 0, NaN and any call outside a run record nothing and never throw | yes | `tests/v2-staging-switch.test.ts` (rules 4825-4827 block) |
| 4827 | At most `MAX_CREDITS` (50) moves a run; the rest are counted in `dropped` | yes | `tests/v2-staging-switch.test.ts` (rules 4825-4827 block) |
| 4828 | The work view shows each move as a step in time order, in both languages, and the run's net in its summary; a run written before rule 4825 shows none | yes | `tests/v2-staging-switch.test.ts` (rules 4828-4829 block) |
| 4829 | A step kind the reader does not know is skipped (`workStep` returns null), never a crash | yes | `tests/v2-staging-switch.test.ts` (rules 4828-4829 block); `tests/v2-work-view.test.ts` |
| 4830 | A golden self-check run needs `SELF_CHECK` on for the host; asked for with it off (live), the run is plain and `selfCheck` is never called | yes | `tests/v2-golden-self-check.test.ts` (rule 4830 block) |
| 4831 | Each case's items pass `selfCheck` after the agent and before the judge, on the golden meter, with a deadline inside the route's 300 s; the judge reads the rewritten items; each result records first score, rewritten and skipped counts | yes | `tests/v2-golden-self-check.test.ts` (rules 4831-4832 block) |
| 4832 | A self-check run is compared, carried and resumed only with runs of its own mode; the next plain run compares with the last plain one | yes | `tests/v2-golden-self-check.test.ts` (rules 4831-4832 block) |
| 4833 | The console offers the self-check button only when the route reports `SELF_CHECK` on; the route accepts only a literal `true`; resume keeps the latest run's mode; the audit row names the mode | yes (source) | `tests/v2-golden-self-check.test.ts` (rule 4833 block) |
| 4834 | The weekly golden cron stays a plain run | yes (source) | `tests/v2-golden-self-check.test.ts` (rule 4833 block) |
| 4835-4839 | Reserved for follow-ups (a per-flag staging banner, recording the overflow and research charges on a run) | | |

Not pinned: the panel in a browser, and a real self-check golden run (it spends model money and is the founder's call). Charges made outside a run (a chat message's overflow, a research card's Approve) are not recorded; rule 4835-4839 can take them.
