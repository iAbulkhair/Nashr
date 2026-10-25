# Coverage: Thakeen v2 phase 1, agents as config (rules 4600-4619)

Status on 2026-10-25 on branch `claude/thakeen-v2-p1-memory` (after C11, a183a2d6). Component C14 of the Claude Doc "Thakeen v2 — PRD, Spec and Roadmap". Flow in `flows.md` section 132; module row `agent-profiles.ts` in `architecture.md`. Release step: **none** (no stored shape, key, flag or environment variable). A refactor: every prompt is byte-identical to before.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4600 | Every task type has exactly one spec, under the agent whose `tasks` lists it, in that order; Reem has none | yes | `tests/v2-agent-profiles.test.ts` (rule 4600 block); `tests/dana-store-data.test.ts` reads the specs from the profiles |
| 4601 | A profile is its `AGENTS` entry unchanged plus `specs` and `reviewFocus`; every skills file exists; no tool, model or cap field, and the tool policy is `on` for every agent without a stored policy | yes | `tests/v2-agent-profiles.test.ts` (rule 4601 block) |
| 4602 | `taskSpec` and `reviewerRubric` read the owner's profile; `noor.ts` keeps no spec or review-focus map | yes | `tests/v2-agent-profiles.test.ts` (rule 4602 block) |
| 4603 | No client component imports `agent-profiles.ts`; `agents.ts` still imports types only; `agent-profiles.ts` imports `./agents` and a type | yes | `tests/v2-agent-profiles.test.ts` (rule 4603 block); `tests/client-bundle.test.ts` |
| 4604 | The combined code hash of all 26 task types is the one before C14 (`620b125dc3f7`); a deliberate prompt change updates it in the same commit, then a golden run | yes | `tests/v2-agent-profiles.test.ts` (rule 4604 block) |
| 4605 | `agent-profiles.ts` reads no store, request or environment: platform code, not customer data | yes | `tests/v2-agent-profiles.test.ts` (rule 4605 block) |
| 4606-4619 | Reserved for C14 follow-ups (a default tool policy per agent, per-agent model purposes) | | |

Known gaps: the byte-for-byte comparison of every prompt (593,390 bytes) was made with a temporary test that is not committed; the committed guard is the combined code hash, which covers the persona, rules, specs, reviewer and judge rubrics but not the chat system prompt (`chat-prompt.ts` reads the persona from `AGENTS`, unchanged). No golden run, since no prompt changed. The roster (`agents.ts`) and the prompt half are two files, because the roster ships to the browser: a ninth agent is one entry in each plus its skills file, and the tests fail until they agree.
