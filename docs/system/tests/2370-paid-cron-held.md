# Coverage: paid scheduled work, charge once, refund always, hold for review (rules 2370-2389)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`: design only, `docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md`. Waits for the founder's decisions in its section 7. Rules 2386-2389 are held for the build's own findings.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2370 | Routine runs pass the claim `routine:{scope}:{id}:{period}` to `generateBatch`; a second attempt with the claim charges nothing | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2371 | Auto-run items pass `handoff:{scope}:{id}:{item}`; an owner's Run of a stale `running` item reuses the claim | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2372 | A refund that throws in the catch leaves the hold for the sweep; `settle` never gives the attempt back while a charge stands | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2373 | `sweepHolds` keeps (drops the hold of) a delivered run's charge | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2374 | `sweepHolds` refunds an undelivered hold once, after deadline + 10 min | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2375 | Each sweep refund writes a `run_refunded` row and an in-app notice | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2376 | `runrec:` is `started` before the charge and `delivered` (with ids) in the commit's round | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2377 | A retry over `delivered` runs nothing and charges nothing | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2378 | A retry over a stale `started` marks it `held`, runs nothing, notifies the owner once | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2379 | The held card's Run uses the same claim; two clicks run once | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2380 | A short batch's partial refund is in the commit's ledger save | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2381 | No partial-refund path is logged-only | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2382 | A held-items refund under a claim is refunded whole (as today) | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2383 | A period that only answered `retry:*` gets one `run_missed` row from the next period's first run | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2384 | `cronreport:{job}:{period}` holds counts only, never an email or scope | designed, not pinned | `tests/paid-cron-held.test.ts` |
| 2385 | The admin overview shows the last report beside the heartbeat | designed, not pinned | `tests/paid-cron-held.test.ts` |
