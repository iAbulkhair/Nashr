# Coverage: Thakeen v2 phase 1, scoped memory and recall (rules 4550-4579)

Status on 2026-10-25 on branch `claude/thakeen-v2-p1-memory` (cut from main abbf2882). Component C5 of the Claude Doc "Thakeen v2 — PRD, Spec and Roadmap". Flow in `flows.md` section 130; keys in `architecture.md` section 3.z.1; `permissions.md` "Scoped memory"; variables in `variables.md` section 5d. Release step: **expand** (new keys `mem:{scope}`, `memprop:{scope}:{id}`, `memprop-done:{scope}:{id}`, `memprop-claim:{scope}:{id}`, `memprops:{scope}`, `memprop-day:{scope}`; optional `memoryProposals` on a chat message). Dormant: `MEMORY_V2` is `false` in `src/lib/v2-flags.ts`.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4550 | Off, the `remember` tool is not offered and answers "Unknown tool.", the memory routes answer 404, recall reads nothing; the switch is a constant | yes | `tests/v2-memory.test.ts` (rule 4550 block) |
| 4551 | A proposed fact is screened before anything is stored: injection, claimed authority, a discount or offer (sent to `update_brand`), a credential value or credential words are refused; ordinary facts pass | yes | `tests/v2-memory.test.ts` (rule 4551 block) |
| 4552 | The agent and conversation labels come from the turn, never from the tool input | yes | `tests/v2-memory.test.ts` (rule 4552 block) |
| 4553 | At most `MEMORY_PROPOSALS_PER_DAY` proposals a day per scope | yes | `tests/v2-memory.test.ts` (rule 4553 block) |
| 4554 | Save writes the fact once (claim, done, `full` at 200); Dismiss writes no fact; a second decision is refused | yes | `tests/v2-memory.test.ts` (rule 4554 block) |
| 4555 | The tool refuses over MCP and for a token, and past three cards a reply | yes | `tests/v2-memory.test.ts` (rule 4555 block) |
| 4556 | Another workspace or another brand never reads, lists or decides a fact; index answers naming another scope's ids are dropped | yes | `tests/v2-memory.test.ts` (rule 4556 block) |
| 4557 | The decision route (`brand.write`, status codes), the card under the reply (at most three) and its state after a reload (`historyFor`), card copy in both languages | yes | `tests/v2-memory.test.ts` (rule 4557 blocks); `tests/role-gates.test.ts` |
| 4558 | `GET /api/memory` lists facts without who saved them; `DELETE` forgets one and 404s an unknown id | yes | `tests/v2-memory.test.ts` (rule 4558 block) |
| 4559 | The account wipe deletes every memory key and drops the index namespace | yes | `tests/v2-memory.test.ts` (rule 4559 block) |
| 4560 | A turn sees brand facts, its own agent's notes and its own thread's facts, nothing else | yes | `tests/v2-memory.test.ts` (recall block) |
| 4561 | Ranking: all visible facts when they fit; past 8, the index or the Arabic-folding word match first, newest fill the rest; a failed index call falls back | yes | `tests/v2-memory.test.ts` (recall block) |
| 4562 | The prompt block is fenced data that a fact cannot close; the index gets text and scope labels only; without the two variables nothing is sent | yes | `tests/v2-memory.test.ts` (recall block) |
| 4563-4579 | Reserved for C5 follow-ups | | |

Known gaps: no memory page in the app yet (the list and forget routes exist, the screen is phase 3's work view); the chat turn's wiring (`recall` before the model call, `runRemember` beside `runTool`) is pinned by source in `tests/v2-phase0.test.ts` rule 4516, not run end to end; not tried against a real Upstash Vector index (body shapes follow its REST docs); a fact the owner saved stays until forgotten or wiped, with no expiry; compaction (C11) and agents as config (C14) are not in this branch. Rules 4580-4699 stay held for the rest of Thakeen v2 by the plan.
