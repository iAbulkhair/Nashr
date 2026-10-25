# Coverage: Thakeen v2 phase 1, thread compaction (rules 4580-4599)

Status on 2026-10-25 on branch `claude/thakeen-v2-p1-memory` (after C5, e4ccb042). Component C11 of the Claude Doc "Thakeen v2 — PRD, Spec and Roadmap". Flow in `flows.md` section 131; keys in `architecture.md` section 3.z.2; `permissions.md` "Thread compaction". Release step: **expand** (new keys `convsum:{scope}` and `convsum:{scope}:{id}`, model purpose and usage kind `compact`). Dormant: `COMPACTION` is `false` in `src/lib/v2-flags.ts`. No new environment variable.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4580 | Off, the turn reads no summary and makes no summary call; the switch is a constant | yes | `tests/v2-compaction.test.ts` (rule 4580 block) |
| 4581 | Four or more dropped messages newer than the summary make one forced `summary` call on `route("compact")` (Haiku 5.5), cut at `COMPACT_MS`, metered to the global counters only, and the summary is stored | yes | `tests/v2-compaction.test.ts` (rule 4581 block); `tests/model-route.test.ts` |
| 4582 | Incremental: the previous summary plus only the messages after its `upTo`; nothing new means no call | yes | `tests/v2-compaction.test.ts` (rule 4582 block) |
| 4583 | Messages and summary go to the summariser as escaped data; the prompt block is fenced data a summary cannot close, empty without one | yes | `tests/v2-compaction.test.ts` (rule 4583 block) |
| 4584 | An error, a paused model, too little time or an empty answer keeps the stored summary, logs one fixed line without the message, and never fails the turn | yes | `tests/v2-compaction.test.ts` (rule 4584 block) |
| 4585 | A summary line that looks like a credential is dropped before storing; summary and each message are length-capped | yes | `tests/v2-compaction.test.ts` (rule 4585 block) |
| 4586 | Facts are at most three, become inferred brand-scope cards only with `MEMORY_V2` on, screened and within the reply's card cap, never over MCP or for a token, never saved without the owner | yes | `tests/v2-compaction.test.ts` (rule 4586 block) |
| 4587 | One summary per scope and thread; a malformed conversation id reads and writes nothing; another account's summary is never read; a malformed stored value reads as none | yes | `tests/v2-compaction.test.ts` (rule 4587 block); `tests/key-registry.test.ts` |
| 4588 | Deleting a conversation deletes its summary; the account wipe deletes them all | yes | `tests/v2-compaction.test.ts` (rule 4588 block) |
| 4589 | Compaction runs after `trimHistory` and before `fitFirstCall`, into the uncached block | yes | `tests/v2-compaction.test.ts` (rule 4589 block) |
| 4590-4599 | Reserved for C11 follow-ups | | |

Known gaps: the chat turn's wiring is pinned by source, not run end to end with the switch on; messages that `fitFirstCall` drops beyond the history guard are not summarised (the guard drops nearly all of them); the summary's quality has not been judged against real long threads (a golden run before switch-on); a summary has no expiry and lives until its conversation is deleted or the account wiped. Agents as config (C14) is not in this branch.
