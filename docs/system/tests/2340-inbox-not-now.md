# Coverage: "Not now" in the approvals inbox (rules 2340-2349)

Status on 2026-10-19 on branch `claude/inbox-not-now` (cut from main 70d16757). Pattern 1 of the Fizzy and Orca study (`docs/reports/2026-10-19-PRD-fizzy-orca_AR.md`); flow in `docs/system/flows.md` section 91. Rules 2348-2349 are held for this work and unused; pattern 2 (one notice per item, chosen digest) takes 2350-2359.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2340 | A set-aside item keeps `status: "pending"` and gains optional `notNow: {at, by: "owner" \| "auto"}`; `touchedAt` records the last non-deciding touch; both are copied to the light row | `tests/not-now.test.ts` ("rules 2340-2341") | — |
| 2341 | `notnow:{scope}` holds exactly the pending ids that are set aside: `saveTask` writes it next to `pending:{scope}`, `dropTasks` and a decision remove the id, `rebuildPending` rebuilds both sets; `waitingIds` is pending minus notnow; the account wipe deletes it | `tests/not-now.test.ts` ("rules 2340-2341"), `tests/key-registry.test.ts` ("rule 2030") | a wipe test that seeds `notnow:` and checks it is gone |
| 2342 | Every waiting count (badge, Reem's walk and agenda, KPIs, daily brief, lifecycle emails, chat page card, 48-hour and low-score nudges, chat and MCP `list_inbox` pending) uses `isWaiting` or `waitingIds` | `tests/not-now.test.ts` ("rule 2342") | — |
| 2343 | `runDaily` moves a waiting item under Not now (`by: "auto"`) once its clock (latest of `createdAt`, `touchedAt`, `Schedule.notNowFrom`) is 14 days old, under the task lock and re-checked on the stored task; `notNowFrom` is stamped by `runDaily` alone on the first run, so release day moves nothing | `tests/not-now.test.ts` ("rule 2343") | — |
| 2344 | One warning per set of items between day 10.5 and day 14 with the days left (fingerprint `notnow-soon:{ids}`, 5 days), and one notice per brand per day after a move, linking to `?view=notnow` | `tests/not-now.test.ts` ("rule 2343", "rule 2344") | — |
| 2345 | `PATCH /api/tasks/{id} {notNow}` (role `drafts`) sets aside or brings back a pending item, else 409 `not_pending` with nothing saved; it records no decision; approve, reject or reopen clears `notNow`; bring back, an edit, a date or a reopen sets `touchedAt` | `tests/not-now.test.ts` ("rule 2345") | — |
| 2346 | The inbox has a Not now chip, a Not now button on waiting cards and Bring back with the date and who moved it; `?view=notnow` opens on the chip | `tests/not-now.test.ts` ("rules 2346-2347") (source shape) | an end-to-end test that sets an item aside and brings it back |
| 2347 | MCP `list_inbox` takes `not_now` and lists only waiting items under `pending`; the chat's `list_inbox` names how many are set aside | `tests/not-now.test.ts` ("rules 2346-2347"), ("rule 2342") | — |
