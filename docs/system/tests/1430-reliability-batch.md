# Coverage: reliability batch (rules 1430-1435)

Status on 2026-10-12 on branch `claude/reliability-batch` (draft PR). Findings: 360 study B-003, B-004, B-005, B-006, F-013, F-023 (`docs/reports/2026-10-11-thakeen-360/findings.jsonl`) and leftovers L063, L075 (`docs/reports/2026-10-10-leftovers-360.md` on branch `claude/leftovers-audit-360-341a20`). Block 1430-1449 is this batch's; 1436-1449 are unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1430 | Reads of many records go through `mgetChunked(keys, size = 100)` (`src/lib/db.ts`): one MGET per 100 keys, at most four in flight, results in key order, null for a missing key, nothing sent for no keys. `listTasks` (the app home, `GET /api/tasks`, the MCP task list, the console's user page) and `rebuildIndex` read task records with it, never one GET per task. `listTasks` keeps the head's order, the pending tail and the ghost cleanup | `tests/reliability-batch.test.ts` (no `task:` GET, three MGETs for 221 keys, same order, ghost cleared; `rebuildIndex` three MGETs for 250 tasks; `mgetChunked` order, nulls, chunk count, empty) | — |
| 1431 | `listConversations` reads its (at most 100) records in one MGET. `searchConversations` reads every thread's newest 200 messages through `pmap` (8 at a time) instead of one awaited LRANGE per thread; hits, the 50-hit cap and the newest-first sort are unchanged | `tests/reliability-batch.test.ts` | — |
| 1432 | Every authenticated call of `POST /api/cron/secretary` (QStash signature or the cron bearer) writes `sec:tick:last` (`sweepReminders(now, { tick: true })`), so on thakeen.com, where the 15-minute tick is an hPanel cron with the bearer, tool answers and the to-do page say a reminder comes "at {time}". The daily cron's fallback sweep still never writes it. Supersedes the "writes `sec:tick:last` only for QStash" clause of rule 299 | `tests/reliability-batch.test.ts` (sweep with and without `tick`), `tests/secretary-phase2.test.ts` (the bearer call now makes `timedReminders()` true; the daily cron still leaves the marker unset) | — |
| 1433 | `userEvents` (the console's per-user counters, read for every user listed) reads its eleven `uev:` counters in one MGET | `tests/reliability-batch.test.ts` | — |
| 1434 | `runDaily` reads the schedule, brand and index stamp in one round, and runs the weekly index rebuild and the daily pending-set reconcile before it checks `dailyBrief`: a workspace with the brief off still has its light index and approvals badge repaired. With the brief off it still answers null and sends nothing | `tests/reliability-batch.test.ts` (brief off: null, pending id restored, `tidxv` written) | — |
| 1435 | No `await db.` in the condition or body of a `for`, `for await`, `while` or `do` loop anywhere under `src/`, except the reviewed list in `tests/redis-loops.test.ts` (lock spin-waits by function name, and `runCronBatch`'s bounded workers). The list has no stale entries. A for-of or for-in header (evaluated once) does not count. The scanner ignores comments, strings, template text and regex literals | `tests/redis-loops.test.ts` (source scan, stale-entry check, and a fixture for loops, conditions, do-while, a single-statement body, comments, strings and `Promise.all`) | — |

## Notes

- Stored shapes: none change (rule 679 not involved). `sec:tick:last` keeps its type and TTL; only who writes it changes.
- No route, permission or environment variable is added. `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` are still read when a QStash call comes (`src/lib/qstash.ts`); unset, only the bearer works.
- Command counts in this file are counted in tests on the memory store, not measured on Upstash.

## Not pinned (live or founder steps)

- B-003: what hPanel and the Upstash QStash console actually schedule today. `docs/release/rollback.md` section 4 lists the read-only check; `GET /api/health?crons=1` shows each cron's last run (rules 1011-1016).
- B-004: Hostinger's real request and stream time limit. `maxDuration` has no effect outside Vercel; the timed test is in `docs/release/rollback.md` section 6, a founder action, staging first.
- F-013: a required status check on the `production` ruleset, and a rehearsed rollback on staging. The procedure is `docs/release/rollback.md`; it has not been run.
- F-023: whether hcdn purges prerendered pages on a new build. The test steps are in `docs/release/rollback.md` section 5; nothing was run against the live site.
- L075 items that are not Redis reads (cron chain hop cap, catalog import SSE, old index rows, referral count cap, vote keys): not in this batch.
