# Paid scheduled work: charge once, refund always, hold for review (design)

Status: **built** on 2026-10-20 after the founder's yes to all three recommendations in section 7 (flows section 95; rule 2383 not built). Written 2026-10-20 on branch `claude/lucid-faraday-kq261a` from main `70d1675`. Item 4 of the OpenDots adoption order (`docs/OpenDots_Adoption.md` section 4). Rules **2370-2389** are reserved for this work. It changes when owners are charged and refunded, so it needs the founder's yes before code (section 7).

## 1. Why

OpenDots runs background work on a lease: a run whose lease expires is marked `interrupted` and **never retried automatically** ("Review completed effects before retrying", its `src/server/store.ts:210-298`); a late result can never overwrite a cancellation. Thakeen's weekly plan is already close to that (a claim hold plus a daily sweep). Routines and Majed's auto-run are not. A read of the code on 2026-10-20 found these windows (cited against `main` 70d1675):

| # | Window | Path | Effect on the owner |
|---|---|---|---|
| W1 | Routine killed after `charge`, before its items are saved | `routines.ts:287` → `generate-batch.ts:376` (plain `charge`, no `once`), no `finally` on a kill | Charged, nothing delivered, **never refunded** (no hold, no sweep). The next day's attempt 2 charges again (`MAX_UNSETTLED` 2, `routines.ts:141,282`) |
| W2 | Routine's refund throws in the catch | `generate-batch.ts:451-453`: `refund` and `settle` in one `Promise.all` | `settle` gives the attempt back while the charge stays; the next run charges again |
| W3 | Routine killed after the saves, before `routinelast` | `generate-batch.ts:442` → `routines.ts:293` | The next run charges again and saves a second set of items |
| W4 | Auto-run killed after the charge | `handoffs.ts:551` writes `running` first; `staleRun` shows it failed after 300 s (`handoffs.ts:229`) | Charged, nothing delivered, never refunded; `autoBlock` never retries it, so an owner pressing Run pays twice |
| W5 | Weekly plan killed after `saveTask`, before `commit` | `generate-batch.ts:442` → `445` | No double charge (the hold is reused), but the retry saves a second weekly plan |
| W6 | Any kill, or a run that answers `retry:*` until its period ends | `cron-batch.ts:44,79,85`; `activity.ts:168-188` writes nothing for `retry:*` | No activity row, no notification: the owner never learns the run did not happen |
| W7 | Partial refund throws (short cart-recovery batch) | `generate-batch.ts:481-484` | Logged and kept by design; the share is lost |

The weekly plan is already safe on money: `chargeOnce` reuses its `paidOnce` hold (`credits.ts:328`) and `sweepWeeklyHolds` refunds an ended week's hold that delivered nothing (`schedule.ts:138-152`). The fix is to give routines and the auto-run the same mechanism, and to add the one thing none of them has: a **run receipt** that turns "it might have half-run" into "held for the owner's review" instead of a silent second attempt.

## 2. Design

### 2.1 One claim per scheduled run (W1, W2, W4)

Every paid scheduled run passes a claim to `generateBatch` (`opts.once`), as the weekly plan already does:

- Routine: `routine:{scope}:{routineId}:{period}`.
- Auto-run: `handoff:{scope}:{handoffId}:{item}`.

`chargeOnce` then charges once per claim, reuses the hold on any retry, and `refundOnce` refunds at most once. The catch's refund failing (W2) leaves the hold in place for the sweep instead of losing the money.

### 2.2 One sweep for every hold (W1, W4, W7)

`sweepWeeklyHolds` becomes `sweepHolds`, run by the daily cron as today. A hold older than its run's deadline plus 10 minutes is:

- **kept** (hold dropped, charge kept) when the run's receipt (2.3) says `delivered`, or when tasks carrying the claim exist;
- **refunded** otherwise.

Each refund writes a `refunded` activity row and an in-app notice. Today's sweep refunds silently, which is W6's money half. The partial refund of a short batch (W7) moves into the same ledger save as the commit, so it can no longer fail on its own.

### 2.3 The run receipt: held for review, never retried blind (W3, W5, W6)

Before the charge, the run writes `runrec:{scope}:{claim}`:

```
{ state: "started", at, job, claim, agent, type }
```

| Event | Receipt state | Where it is written |
|---|---|---|
| Items saved | `delivered`, with their ids | In the same `Promise.all` as the commit (`lastWeekly` / `routinelast` / item `done`) |
| Batch refunded | `refunded` | The catch |
| A later attempt finds `started` older than the deadline | `held` | That later attempt (see below) |

A later attempt that finds `started` older than the run's deadline does **not** run. It marks the receipt `held` and returns `held`, which `runCronBatch` treats as done. It then tells the owner once:

> "Noor's weekly cart-recovery did not finish on Monday. Nothing new was charged (or: the charge was returned). Run it now?"

That card runs the stored claim through the existing spend-card route, with the same claim, so it cannot double-charge. This is OpenDots' "Retry after review", over Thakeen's approval-first UI.

A receipt in state `delivered` makes any retry a no-op (W3, W5). Ids are random today (`generate-batch.ts:253`), so the receipt, not the task, is the idempotency key.

### 2.4 What the owner and the founder see (W6)

- **Owner.** Every scheduled run that does not deliver in its period leaves exactly one activity row and one notice, whatever the reason:
  - `held` (the card above);
  - `refunded`;
  - `skipped:{reason}` for the existing refusals;
  - `missed` for a period that ended while it only ever answered `retry:*`.

  `missed` is written by the next period's first run, which reads the receipt-less previous period.
- **Founder.** `runCronBatch` stores its report (counts only: total, done, failed, held, remaining) in `cronreport:{job}:{period}`, 14 days. The admin overview shows the last report next to the heartbeat, which today means only "the route finished" (`cron-heartbeat.ts:10-12`).

## 3. Shapes and releases (rule 679)

- **Expand.**
  - New keys: `runrec:` (TTL = period + 14 days) and `cronreport:`. New activity kinds: `run_held`, `run_refunded`, `run_missed`.
  - `paidOnce` claims get two new prefixes (`routine:`, `handoff:`) in the existing `User.paidOnce` map. Older code reads that map only by exact claim, so it ignores them.
  - The sweep reads both the old weekly holds and the new ones.
- **Contract.** None needed: nothing old is removed.
- **No data conversion.** Routine charges made before the release have no hold, so the sweep cannot see them. W1 charges from before the release stay as they are, and the founder can refund them by hand from the console. (I'm not sure how many exist; `usage:` does not tell a delivered routine charge from an undelivered one.)

## 4. Tests to write (rules 2370-2389)

| Rule | Pins |
|---|---|
| 2370-2372 | Routine and auto-run pass a claim; a second attempt with the same claim charges nothing; a refund that throws leaves the hold (W1, W2, W4) |
| 2373-2375 | The sweep keeps a delivered hold, refunds an undelivered one once, and writes a row and a notice for each refund |
| 2376-2379 | The receipt: `started` → `delivered` in the commit's round; a retry over `delivered` is a no-op; over a stale `started` it becomes `held` and runs nothing; the card's Run uses the same claim |
| 2380-2382 | Short-batch refund in the commit's ledger save; no path leaves it logged-only |
| 2383-2385 | `missed` is written once for a period that only answered `retry:*`; `cronreport:` holds counts only, no email |
| 2386-2389 | Held for the build's own findings |

A kill cannot be simulated by a thrown error: `finally` would run. The tests stop the fake `db` after the step under test, the way `tests/publish-once.test.ts` models a lost answer.

## 5. Cost and size

- About 2-3 days with tests. The ledger code (`credits.ts`) is touched only through its existing `chargeOnce` / `refundOnce` / sweep functions, generalised from weekly-only.
- Redis: +1 `set` per scheduled run (the receipt) and +1 `mget` per run on retry. The daily sweep already reads every account's `paidOnce`.

## 6. Not in this spec

- Leases for chat-started batches: they run inside a request whose own refund path is covered.
- Media renders: they have their own durable jobs and sweep (`media/jobs.ts`).
- A queue or worker process. Hostinger's cron plus the receipt is enough at today's volume.

## 7. Founder decisions needed

1. **Yes or no to the change in money behaviour.** Routines and the auto-run would charge once per claim, and undelivered holds would be refunded automatically by the daily sweep. Today some are charged twice or never refunded (W1, W2, W4).
2. **The held card.** Should a held run wait for the owner's Run (proposed), or should Thakeen retry it once on its own after the sweep has refunded it?
3. **Charges made before the release.** Refund them by hand case by case (proposed), or run a one-time scan? A scan can only guess which charges were undelivered.
