# Coverage: paid scheduled work, charge once, refund always, hold for review (rules 2370-2389)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`: built after the founder's yes to the spec's three recommendations (`docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md`); flows in `docs/system/flows.md` section 95. Rules 2386-2389 are held.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2370 | Routine runs pass the claim `routine:{scope}:{id}:{period}` to `generateBatch`; a second attempt with the claim charges nothing | `tests/routines.test.ts` ("rules 2370, 2378": a killed run is charged once); `tests/paid-cron-held.test.ts` ("rules 2370-2371") | — |
| 2371 | Auto-run items pass `handoff:{scope}:{id}:{item}`; an owner's Run of a stale `running` item reuses the claim | `tests/paid-cron-held.test.ts` ("rules 2370-2371": source; "rules 2373-2375": the handoff hold kept or refunded by item status) | — |
| 2372 | A refund that throws in the catch leaves the hold for the sweep, and the receipt stays `started`, so the next attempt holds the run instead of charging again (`settle` may still give the routine's attempt back; the claim makes that harmless) | not pinned directly: a refund that throws writes nothing, so the hold stays for the sweep, whose refund is pinned (2374) | `tests/paid-cron-held.test.ts` |
| 2373 | `sweepHolds` keeps (drops the hold of) a delivered run's charge | `tests/paid-cron-held.test.ts` ("rules 2373-2375") | — |
| 2374 | `sweepHolds` refunds an undelivered hold once, after deadline + 10 min | `tests/paid-cron-held.test.ts` ("rules 2373-2375": refunded once, a young hold left alone) | — |
| 2375 | Each sweep refund writes a `run_refunded` row and an in-app notice | `tests/paid-cron-held.test.ts` ("rules 2373-2375": one `run_refunded` row, one notice) | — |
| 2376 | `runrec:` is `started` before the charge and `delivered` (with ids) in the commit's round | `tests/paid-cron-held.test.ts` ("rules 2376-2377") | — |
| 2377 | A retry over `delivered` runs nothing and charges nothing | `tests/paid-cron-held.test.ts` ("rules 2376-2377"); `tests/weekly-money.test.ts` (a lost marker: `already_this_week`, one plan) | — |
| 2378 | A retry over a stale `started` marks it `held`, runs nothing, notifies the owner once | `tests/routines.test.ts` and `tests/weekly-money.test.ts` (held, no generation, no charge); the notice's text is not asserted | — |
| 2379 | The held card's Run uses the same claim; two clicks run once | `tests/paid-cron-held.test.ts` ("rule 2379"); resume reuses the charge in `tests/routines.test.ts` and `tests/weekly-money.test.ts` | — |
| 2380 | A short batch's partial refund is in the commit's ledger save | `tests/paid-cron-held.test.ts` ("rule 2380") | — |
| 2381 | No partial-refund path is logged-only | not pinned: `oweRun` on a failed partial refund needs a ledger that throws mid-batch | `tests/paid-cron-held.test.ts` |
| 2382 | A held-items refund under a claim is refunded whole (as today) | unchanged behaviour, pinned by the existing agent-scope tests | — |
| 2383 | A period that only answered `retry:*` gets one `run_missed` row from the next period's first run | **not built** (flows section 95 item 6) | `tests/paid-cron-held.test.ts` |
| 2384 | `cronreport:{job}:{period}` holds counts only, never an email or scope | `tests/paid-cron-held.test.ts` ("rules 2384-2385") | — |
| 2385 | The admin overview shows the last report beside the heartbeat | `tests/paid-cron-held.test.ts` ("rules 2384-2385": `cronStatuses`); the Usage page line is not render-tested | — |
