# Coverage: admin control center, agents, workflow, feature flags and audit (rules 1050-1079)

Status on 2026-10-11 on branch `claude/prompt-studio-specs`: design only, `docs/superpowers/specs/2026-10-11-admin-control-center-design.md`. Builds on draft PR #316 (rules 930-959) and assumes it merges first. No code yet, so every rule is designed and none is pinned. The last column names the test file each build phase (spec section 17, phases 1-7) adds.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1050 | `ctl:state` absent or partial = today's behaviour; parse drops unknown ids | designed, not pinned | `tests/admin-control.test.ts` |
| 1051 | 10-second in-process cache; read error keeps the last value; no value ever read = pause on for model calls | designed, not pinned | `tests/admin-control.test.ts` |
| 1052 | `metered()` throws `ModelPaused` before any stream while `ctl.pause.on` or `CLAUDE_PAUSED` | designed, not pinned | `tests/admin-control.test.ts` |
| 1053 | Every charging entry point refreshes the control state before `modelState()`; a `ModelPaused` throw refunds | designed, not pinned | `tests/admin-control.test.ts` |
| 1054 | Agent off (global or for a plan) removes it from `entitlements(u, now, ctl).agents`; chat, MCP, `generateBatch` callers, handoffs and the #316 test refuse `agent_off` with no charge | designed, not pinned | `tests/admin-control.test.ts` |
| 1055 | Reem off stops her model calls only; reminders, feed and bookings continue | designed, not pinned | `tests/admin-control.test.ts` |
| 1056 | Model override only from `MODEL_CHOICES`; 409 `margin_floor` below 60%; the floor test iterates every choice | designed, not pinned | `tests/admin-control.test.ts` |
| 1057 | Effective model: customer pick > founder override > `TASK_MODELS`; one function for call and price | designed, not pinned | `tests/admin-control.test.ts` |
| 1058 | Agent costs read from existing usage counters only | designed, not pinned | `tests/admin-control.test.ts` |
| 1059 | Forced approval ignores `autoApprove` for listed types at creation and judge withdrawal; existing items unchanged | designed, not pinned | `tests/admin-control.test.ts` |
| 1060 | Publish hold refuses `publish_held` inside publish-once before any connector call, Composio drafts included | designed, not pinned | `tests/admin-control.test.ts` |
| 1061 | Platform quiet day: weekly, routines, Majed auto-run and Reem nudges skip without charge for matching countries; owner actions not blocked | designed, not pinned | `tests/admin-control.test.ts` |
| 1062 | `CRONS` equals `crons.json` plus the secretary tick plus the learning crons; every cron writes `cronrun:{name}` at start and end; status rules | designed, not pinned | `tests/admin-control.test.ts` |
| 1063 | Run now only for `safeToRun`; server-side function call; no `CRON_SECRET` leaves the server | designed, not pinned | `tests/admin-control.test.ts` |
| 1064 | Queue health reads only global structures | designed, not pinned | `tests/admin-control.test.ts` |
| 1065 | `stuck:{kind}` maintained on enter and leave; retry through the existing idempotent path; never charges | designed, not pinned | `tests/admin-control.test.ts` |
| 1066 | Flag on refused 409 `env_missing` with names; effective = env ready and switch; env removed = off | designed, not pinned | `tests/admin-control.test.ts` |
| 1067 | Flags and control answers carry names and booleans only, never values | designed, not pinned | `tests/admin-control.test.ts` |
| 1068 | Redis can only narrow env: `PAYMOB_LIVE`, `LLM_PROVIDER`, `MEDIA_MODELS_ON` stay env; `straitly` off sends direct | designed, not pinned | `tests/admin-control.test.ts` |
| 1069 | `adminAudit` is the only writer of `admin:log` (source test) | designed, not pinned | `tests/admin-control.test.ts` |
| 1070 | Control-center writes need a reason of 3-200 characters (400 `reason_required`) | designed, not pinned | `tests/admin-control.test.ts` |
| 1071 | No secret value in any audit row or `ctl:hist` (test with planted values) | designed, not pinned | `tests/admin-control.test.ts` |
| 1072 | Log filters and paging; legacy rows shown | designed, not pinned | `tests/admin-control.test.ts` |
| 1073 | No `prompt(`, `confirm(` or `alert(` in `src/components/admin` (source test); `FormDialog` typed fields | designed, not pinned | `tests/admin-control.test.ts` |
| 1074 | Every control write asks through a dialog; destructive styling for pause, off, hold | designed, not pinned | `tests/admin-control.test.ts` |
| 1075 | `adminCan` checked on every admin route; founders pass everything; the support map is data | designed, not pinned | `tests/admin-control.test.ts` |
| 1076 | Writes under `ctl:lock` with `v`; stale 409 | designed, not pinned | `tests/admin-control.test.ts` |
| 1077 | Staging and live states are separate; export carries no emails or values | designed, not pinned | `tests/admin-control.test.ts` |
| 1078 | Rate limits as section 13, each 429 with `Retry-After` | designed, not pinned | `tests/admin-control.test.ts` |
| 1079 | Reserved for follow-ups | designed, not pinned | `tests/admin-control.test.ts` |

## Not pinned

- All of 1050-1079: nothing is built. Each phase of spec section 17 pins its rules in `tests/admin-control.test.ts` (source and fixture tests; the suite has no DOM) and moves its rows to pinned in the same change.
- 1056 also extends `tests/pricing-floor.test.ts` to every model in `MODEL_CHOICES`.
- 1073 finishes what rule 960's "Not pinned" list left open: the console's remaining `prompt()` and `confirm()` calls.
- 1079 is reserved for follow-ups.
