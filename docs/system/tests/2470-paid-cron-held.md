# Coverage: paid scheduled work, charge once, refund always, hold for review (rules 2470-2489)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`: built after the founder's yes to the spec's three recommendations (`docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md`); flows in `docs/system/flows.md` section 98. Rule 2486 is the founder's read-only list of earlier losses; rules 2487-2489 are held.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2470 | Routine runs pass the claim `routine:{scope}:{id}:{period}` to `generateBatch`; a second attempt with the claim charges nothing | `tests/routines.test.ts` ("rules 2470, 2478": a killed run is charged once); `tests/paid-cron-held.test.ts` ("rules 2470-2471") | — |
| 2471 | Auto-run items pass `handoff:{scope}:{id}:{item}`; an owner's Run of a stale `running` item reuses the claim | `tests/paid-cron-held.test.ts` ("rules 2470-2471": source; "rules 2473-2475": the handoff hold kept or refunded by item status) | — |
| 2472 | A refund that throws in the catch leaves the hold for the sweep, and the receipt stays `started`, so the next attempt holds the run instead of charging again (`settle` may still give the routine's attempt back; the claim makes that harmless) | not pinned directly: a refund that throws writes nothing, so the hold stays for the sweep, whose refund is pinned (2474) | `tests/paid-cron-held.test.ts` |
| 2473 | `sweepHolds` keeps (drops the hold of) a delivered run's charge | `tests/paid-cron-held.test.ts` ("rules 2473-2475") | — |
| 2474 | `sweepHolds` refunds an undelivered hold once, after deadline + 10 min | `tests/paid-cron-held.test.ts` ("rules 2473-2475": refunded once, a young hold left alone) | — |
| 2475 | Each sweep refund writes a `run_refunded` row and an in-app notice | `tests/paid-cron-held.test.ts` ("rules 2473-2475": one `run_refunded` row, one notice) | — |
| 2476 | `runrec:` is `started` before the charge and `delivered` (with ids) in the commit's round | `tests/paid-cron-held.test.ts` ("rules 2476-2477") | — |
| 2477 | A retry over `delivered` runs nothing and charges nothing | `tests/paid-cron-held.test.ts` ("rules 2476-2477"); `tests/weekly-money.test.ts` (a lost marker: `already_this_week`, one plan) | — |
| 2478 | A retry over a stale `started` marks it `held`, runs nothing, notifies the owner once | `tests/routines.test.ts` and `tests/weekly-money.test.ts` (held, no generation, no charge); the notice's text is not asserted | — |
| 2479 | The held card's Run uses the same claim; two clicks run once | `tests/paid-cron-held.test.ts` ("rule 2479"); resume reuses the charge in `tests/routines.test.ts` and `tests/weekly-money.test.ts` | — |
| 2480 | A short batch's partial refund is in the commit's ledger save | `tests/paid-cron-held.test.ts` ("rule 2480") | — |
| 2481 | No partial-refund path is logged-only | not pinned: `oweRun` on a failed partial refund needs a ledger that throws mid-batch | `tests/paid-cron-held.test.ts` |
| 2482 | A held-items refund under a claim is refunded whole (as today) | unchanged behaviour, pinned by the existing agent-scope tests | — |
| 2483 | A period that only answered `retry:*` gets one `run_missed` row from the next period's first run | **not built** (flows section 98 item 7) | `tests/paid-cron-held.test.ts` |
| 2484 | `cronreport:{job}:{period}` holds counts only, never an email or scope | `tests/paid-cron-held.test.ts` ("rules 2484-2485") | — |
| 2485 | The admin overview shows the last report beside the heartbeat | `tests/paid-cron-held.test.ts` ("rules 2484-2485": `cronStatuses`); the Usage page line is not render-tested | — |
| 2486 | `scripts/lost-scheduled-charges.ts` lists, read only, the scheduled charges lost before this release (a routine period's unsettled charges less the one its recorded run delivered; a handoff item left `running` past its lock, marked "check"), and never lists one the new sweep handles (a receipt or a claim hold) | `tests/lost-charges.test.ts` ("rule 2486") | — |

The held-routine Run button and the Usage page's cron counts, which no browser reached, are rendered by `tests/held-routine-screens.test.ts` (rules 2530-2532, `docs/system/tests/2530-held-routine-screens.md`).
