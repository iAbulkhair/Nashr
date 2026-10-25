# Coverage: Thakeen v2 phase 2, goals and plans, the durable queue and the self-check (rules 4620-4689)

Status on 2026-10-25 on branch `claude/thakeen-v2-p2-plans` (after phase 1, c431f09f). Components C3, C7 and C6 of the Claude Doc "Thakeen v2 — PRD, Spec and Roadmap". Flows in `flows.md` sections 133-135; keys in `architecture.md` section 3.z.3; `permissions.md` "Goals and plans, the queue and the self-check". Release step: **expand** (new keys `goalplan:*`, `goalplans:*`, `goalplanlock:*`, `goalplan-day:*`, `qjob:*`, `jobq:*`, `qjobs:*`, `qscopes`, claim prefix `planstep:`, optional `Task.plan` and `Task.selfCheck`, chat message field `goalPlan`). Dormant: `PLANS`, `QUEUE` and `SELF_CHECK` are `false` in `src/lib/v2-flags.ts`. No new environment variable. Founder decision 2026-10-25: a self-check rewrite is inside the plan's or routine's price, never an extra charge.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4620 | The three switches are constants shipped `false`; off, Majed is not offered `make_plan`, the tool name is unknown, both plan routes are 404, the queue tick and its cron read nothing | yes | `tests/v2-plans.test.ts` (rule 4620 block) |
| 4621 | A plan is parsed in code: 2 to `PLAN_MAX_STEPS` (8) steps, each a plan type (no Reem type), a brief within `PLAN_BRIEF_MAX`, the goal within `PLAN_GOAL_MAX` | yes | `tests/v2-plans.test.ts` (rules 4621-4625 block) |
| 4622 | A step waits only for earlier steps (at most 3), so a plan has no cycle; hidden characters are stripped from goal and briefs | yes | `tests/v2-plans.test.ts` (rules 4621-4625 block) |
| 4623 | Each step's agent (`agentForTask`) and cost (`TASK_COST`), the total, the status and the scope are set in code, never by the model | yes | `tests/v2-plans.test.ts` (rules 4621-4625 block) |
| 4624-4625 | The record lives 90 days from its last write; the index keeps the `PLANS_KEEP` (20) newest, and one pushed past it leaves with its record | no (keys only) | `tests/v2-plans.test.ts`: push 21 plans; `tests/key-registry.test.ts` pins the keys |
| 4626 | `make_plan` is Majed's only, never over MCP or for an API token, one plan a reply, `PLANS_PER_DAY` (10) proposals a scope a day | partly (the day's cap is not run) | `tests/v2-plans.test.ts` (rules 4626-4628 block) |
| 4627 | Proposing charges nothing, queues nothing and runs nothing; a refused draft saves nothing | yes | `tests/v2-plans.test.ts` (rules 4626-4628 block) |
| 4628 | The proposal is shown as a plan card on the chat message (`goalPlan`, a checked id only); the plan text the model reads back is data | yes | `tests/v2-plans.test.ts` (rules 4626-4628 block) |
| 4629 | The card's words exist in both languages and the card renders plain text, no markup | yes | `tests/v2-plans.test.ts` (card test) |
| 4630 | `POST /api/plans/{id}` (approve, pause, resume, cancel) needs `generate` (member), is rate-limited per scope, and takes no scope, step or cost from the body | yes | `tests/role-gates.test.ts`; `tests/v2-plans.test.ts` (routes test) |
| 4631 | `GET /api/plans/{id}` needs `read` (viewer); the id is checked against its format before a key is built; another account's id is 404 | yes | `tests/role-gates.test.ts`; `tests/v2-plans.test.ts` (rules 4629-4633 block) |
| 4632 | A step's batch keeps the plan and step on every task it makes (`Task.plan`), and every item waits in the inbox (`forcePending`) | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4633 | Approve is the only approval, under the plan's lock: queue off refuses, a fresh balance under the total is `no_credits`, a passed agent cap is `agent_cap`, older than 7 days is `expired`, a second Approve is `not_proposed`; it charges nothing and queues only the steps that wait for nothing | yes | `tests/v2-plans.test.ts` (rules 4629-4633 block) |
| 4634 | A step is charged under its own claim (`planstep:`); the daily hold sweep keeps a delivered step's hold and refunds one that never delivered | yes (source) | `tests/v2-plans.test.ts` (sweep test) |
| 4635 | The tick runs at most one job of a scope, and only with `BATCH_RUN_MIN_MS` left | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4636 | A later step is queued only when its earlier steps are done and every item they made is approved | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4637 | A refusal before the charge pauses the plan for the owner; Resume queues it again | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4638 | A run that fails is tried again once, then the step and the plan stop as `failed` | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4639 | Pause takes the waiting jobs out of the queue; Cancel ends the plan and nothing more of it runs | yes | `tests/v2-plans.test.ts` (rules 4634-4649 block) |
| 4640-4649 | Reserved for C3 follow-ups | | |
| 4650 | A job (`qjob:{scope}:{id}`) is one step of one plan of the same scope, every field set in code; 30 days | partly (keys) | `tests/key-registry.test.ts` |
| 4651 | One waiting list per scope, oldest first, at most `QUEUE_MAX` (40); a batch that would pass it is refused whole (`queue_full`) | no | `tests/v2-plans.test.ts`: enqueue 41 |
| 4652 | The platform set `qscopes` holds only scopes from our own records; the account wipe removes every plan, step receipt, job and the list | yes | `tests/v2-plans.test.ts` (wipe test) |
| 4653 | A job's attempts are counted before its work, at most `QUEUE_MAX_ATTEMPTS` (2) starts whatever happens | partly (through the retry test) | `tests/v2-plans.test.ts`: a killed run leaves its count |
| 4654 | Reserved | | |
| 4655 | `GET /api/cron/queue` compares the bearer with `sameSecret` first; off it answers `{ ok: true, off: true }` | yes | `tests/v2-plans.test.ts` (rule 4620 block) |
| 4656 | Each scope runs through `runAsAccount` (a deleted, suspended or archived account is skipped before any write), four at a time, none started after 160 s | no | `tests/v2-plans.test.ts`: the route with `QUEUE` on |
| 4657 | A scope its account may no longer act for leaves the set; its jobs stay until the wipe | no | as 4656 |
| 4658 | `enqueue` and `resumePlan` write their work before they add the scope, so a racing tick sees it | no | — |
| 4659 | Reserved | | |
| 4660 | The tick is kicked by Reem's 15-minute tick only while `QUEUE` is on, with a daily fallback in `crons.json` and a heartbeat age | yes (source) | `tests/v2-plans.test.ts` (cron test) |
| 4661-4669 | Reserved for C7 follow-ups | | |
| 4670 | Off, `selfCheck` returns the same tasks with no model call; only routines and plan steps ask for it, never an owner's own request | yes | `tests/v2-self-check.test.ts` (rule 4670 block) |
| 4671 | Weak = under `SELF_CHECK_BAR` (70) or auto-failed; at most `SELF_CHECK_MAX_REWRITES` (3) a batch, lowest score first; past the cap an item keeps its text with `skipped: "cap"` | yes | `tests/v2-self-check.test.ts` (rules 4671-4679 block) |
| 4672 | Each task carries `Task.selfCheck` (`first`, `autofail`, `rewritten`, `skipped`), expand-only | yes | `tests/v2-self-check.test.ts` |
| 4673 | The judge's note is a reviewer's data in `<reviewer_note>`, never the owner's request (`reviseDraft` is not used); the draft is data too | yes | `tests/v2-self-check.test.ts` (rules 4671-4679 block) |
| 4674 | A rewrite is metered as usage (`generate`) on the batch's model and never charged in credits | yes | `tests/v2-self-check.test.ts` |
| 4675 | The self-check runs before the output scope check, so a rewritten item is checked like any other | yes (source) | `tests/v2-self-check.test.ts` |
| 4676 | An auto-failed item that would be auto-approved goes to the inbox before its save, rewritten or not; the final score stays `judgeLater`'s | yes | `tests/v2-self-check.test.ts` (rules 4671-4679 block) |
| 4677-4679 | Reserved for C6 follow-ups | | |
| 4680 | Less than `SELF_CHECK_MIN_MS` (150 s) left: nothing is scored, every item says `time` | yes | `tests/v2-self-check.test.ts` (rules 4680-4689 block) |
| 4681 | No verdict from the judge: `judge`, the text unchanged | yes | `tests/v2-self-check.test.ts` (rules 4680-4689 block) |
| 4682 | A failed or empty rewrite keeps the draft with `error`; a rewrite starts only with 45 s left before the 15 s reserve | yes (the time guard by source) | `tests/v2-self-check.test.ts` (rules 4680-4689 block) |
| 4683-4689 | Reserved | | |

Known gaps: nothing here was run end to end with the switches on against Redis and the model (a staging run before switch-on); the queue route with `QUEUE` on, its race guard (4658) and a scope leaving the set (4657) are not run; a cross-review verdict on an item stays on it after a rewrite (items it flags are already pending); the self-check's quality gain has not been measured on golden (run golden with `SELF_CHECK` on before switch-on). Switching the queue on also needs the hPanel cron entry for `/api/cron/queue` (a founder step, like the other crons).
