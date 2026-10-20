# Coverage: background jobs carry the workspace they act for (rules 2500-2509)

Status on 2026-10-20 on branch `claude/jobs-carry-account-dfe36f`: built (pattern 6 of `docs/reports/2026-10-19-PRD-fizzy-orca_AR.md`, after Fizzy's jobs restoring `Current.account`); flows in `docs/system/flows.md` section 102. Rules 2500-2509 are written; 2512-2519 are held (2510-2511 went to #410, CI in production's person shape). Tests: `tests/jobs-carry-account.test.ts`, and `tests/notif-digest.test.ts` (its sending tests now use real accounts, since the tick reads the account again).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2500 | Every per-user cron item carries `jobRef(u)` = `{account: acct(u), scope: sc(u)}` from the roster's record, taken at listing time, never from the request | `tests/jobs-carry-account.test.ts` ("rule 2500"; "rule 2506": source of the five routes, and `job-account.ts` names no request field) | — |
| 2501 | `resumeJob` reads the account again and hands the work a fresh `User` with `brandId` and `scope` set | `tests/jobs-carry-account.test.ts` ("rules 2501-2505": a balance changed after the listing is seen) | — |
| 2502 | A scope that is not the carried account's (`accountOfScope`) is refused before any read | `tests/jobs-carry-account.test.ts` ("rule 2502": no `db.get`) | — |
| 2503 | An account that is gone, or whose record is keyed elsewhere, is skipped | `tests/jobs-carry-account.test.ts` ("rule 2503") | — |
| 2504 | A suspended account, or an owner whose address is not verified (rule 755), is skipped | `tests/jobs-carry-account.test.ts` ("rule 2504") | — |
| 2505 | A scope whose brand is archived or not on the account's brand list is skipped | `tests/jobs-carry-account.test.ts` ("rule 2505") | — |
| 2506 | The daily, weekly, routines, evening and stores crons start an item only through `runAsAccount`; a skip writes, charges and sends nothing and is the item's final outcome for the period | `tests/jobs-carry-account.test.ts` ("rule 2506": an account suspended after the listing is not charged, its item is done for the period; source of all five routes) | — |
| 2507 | The digest tick reads the account again once a window ended: a gone account leaves `notifydigests` and its choice and window go | `tests/jobs-carry-account.test.ts` ("rule 2507") | — |
| 2508 | A suspended or unverified account's digest is `held`: no email, the window stays open | `tests/jobs-carry-account.test.ts` ("rule 2508") | — |
| 2509 | The digest goes to the account's current address, never the `to` saved with the choice | `tests/jobs-carry-account.test.ts` ("rule 2509"); `tests/notif-digest.test.ts` (rule 2354 tests, `to` is the account's address) | — |
| 2510-2511 | Used by #410 (not this change) | — | — |
| 2512-2519 | Held | — | — |

## Audit: every background job, before this change

| Job | Account context it carries | How it resolves the scope | Re-checks at run (exists / not paused or deleted / item in scope) | After this change |
|---|---|---|---|---|
| `/api/cron/daily` (`runCronBatch`, `dailyFor`) | A `User` snapshot per (account, active brand) from `dailyRoster`, listed once per hop | `u.scope` set by `scopeFor` over the account's own brand list; `acct(u)` for account keys | Only at listing. A run started up to 4 min later used the snapshot. Charges (`renewPaymob`, `renewIfDue`, hold sweeps) re-read under `withUserLock` (gone = throws, no charge); a suspension or brand archive mid-hop was not seen | `ref: jobRef(user)` per item; `runAsAccount` (2500, 2506) |
| `/api/cron/daily` idle items (`purgeIdle`) | A scope string from the roster's idle list | The scope itself | None needed: it only deletes Reem's items deleted over 30 days ago, for archived brands and suspended accounts on purpose | Unchanged |
| `/api/cron/weekly` (`runWeekly`) | `User` snapshot from `allUsers` | `u.scope` | Only at listing; the plan's charge re-reads the balance under the lock but not the suspension or brand status | `runAsAccount` |
| `/api/cron/routines` (`runRoutine`, `autoRunHandoff`) | `User` snapshot plus routine id or handoff id and item | `u.scope`; the handoff and routine records are read again under the scope's run lock (switched off, run, declined, conversation deleted) | Item: yes, under the lock. Account: no | `ref` per item; `runAsAccount` (the item checks stay) |
| `/api/cron/evening` (`eveningWrap`) | `User` snapshot | `sc(u)` | Only at listing; it mails | `runAsAccount` |
| `/api/cron/stores` (`syncStoreIfDue`) | `User` snapshot; the first-hop passes take the roster's scope list | `sc(u)` | Only at listing; it writes the sales snapshot (no charge). The passes (Shopify redactions, keep-alive, uninstall hooks, health counts) act on connections and run for idle scopes on purpose | Syncs: `runAsAccount`. Passes unchanged |
| `/api/cron/secretary` tick, reminders (`sweepReminders`) | A scope in the `dueScopes` sorted set | `accountOfScope(scope)` | Yes: `getUser` + `listBrands` per account; gone leaves the index; suspended, unverified or brand not active are held | Unchanged (already built) |
| Tick, calendars (`sweepCalendars`, `syncLocked`) | A scope in `calDue` | `accountOfScope(scope)` | Yes, under the brand's calendar lock: account, suspension, the linked login is the owner's, brand archived or active, domain proof | Unchanged (already built) |
| Tick, digests (`sweepDigests`, `digestFor`) | An account id in `notifydigests` | `accountKey.*(account)` | No: a suspended account was mailed, and the address saved with the choice was used | Re-read before the claim (2507-2509) |
| Tick, evening kick | Zones only (`?zones=`, allow-listed) | — | — | Unchanged; the evening batch it starts re-checks |
| `/api/cron/media` (`sweepMedia`) | The job record: `scope`, paying account, `accountSince` (stored at creation from `sc(u)` and the account) | The record's own scope (`storedScope`) | Yes: a refund goes only to an account whose `createdAt` equals `accountSince` (spec A32); reads and writes only under the job's scope | Unchanged (already built) |
| Chain hops (`runCronBatch` calling itself) | Only `?chain=` and the bearer | The roster is listed again on each hop | — | Unchanged |
| `/api/cron/golden`, margin alert | No account (founder's evaluation, founder's alert) | — | — | Out of scope |
| QStash | The tick only: a signed, body-hashed call with no per-account payload | — | — | Nothing enqueued with an account; nothing to carry |
| In-request `after()` work (judge, media `maybeSweep`, stats syncs) | The request's own `sc(u)`, in the same invocation | `sc(u)` | Not a stored job | Out of scope |

## Decisions made without the founder (delegated, 2026-10-20)

1. A skip is final for the period, not retried: the next day's roster decides again, as it already does for suspended and unverified accounts.
2. The digest mails the account's current address instead of the saved `to`. The stored record keeps its shape, so no expand/contract step and no data script.
3. The guard is a wrapper the routes call (`runAsAccount`), not a change inside `runCronBatch`, so the batch stays generic and idle purges keep running for suspended accounts.
4. `src/lib/hold-sweep.ts` and the onboard-hold sweep are untouched (draft PR #407 changes hold-sweep refunds); they now run with the fresh `User` that `runAsAccount` hands `dailyFor`.
5. Cost: two extra Redis reads per item (one round), in parallel inside the batch's bounded concurrency.
