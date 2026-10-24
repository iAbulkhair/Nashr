# Coverage: paid extra seats (rules 3360-3379)

Status on 2026-10-23, branch `claude/sup-paid-seats`. 25 SAR per extra seat per month before VAT, above each plan's included seats, bought by the owner's own session with an explicit confirm, usable at once, charged from the next renewal, trimmed at renewal when the team shrank. Flow: `docs/system/flows.md` section 121. Spec: `docs/superpowers/specs/2026-10-23-paid-seats.md`. Release step: expand (`extraSeats` on the account and on a renewal intent are new optional fields; absent reads as 0).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3360 | The seat price is `EXTRA_SEAT_MONTHLY_SAR = 25` in `src/lib/pricing.ts` and nowhere else; no copy types the number | `tests/paid-seats-3360.test.ts` "the price" | none |
| 3361 | VAT on seats is 15% rounded to the halala, on the sum of plan and seats (`vatHalalasOf`, `extraSeatsLine`, `monthlyTotal`) | `tests/paid-seats-3360.test.ts` | none |
| 3362 | No yearly seat interval: a year is 12 monthly charges | not pinned (no yearly interval exists to test) | a test once a yearly billing interval exists |
| 3363 | Only starter, pro and business sell seats; a trial and Agency read 0 extra whatever is stored and cannot buy | `tests/paid-seats-3360.test.ts` "the seat count", "a trial cannot buy", "Agency and a locked bill" | none |
| 3364 | One source of truth: `extraSeats` on the account, and one seat count, `seatCount` in `src/lib/team.ts` (no other module recomputes it); absent or junk reads 0; capped at `MAX_SEAT_OVERRIDE`; the founder's `seats` override still sets the included seats; billable = max(0, `seatCount` − included), where `seatCount` is M3's (rule 3753: owner + admins + Editors not paused + invites, the first 3 Viewers free), so a free Viewer is never billed | `tests/paid-seats-3360.test.ts` ("one seat count" scans src; "free viewers": 3 Viewers = 0 extra seats, the 4th = 1) | none |
| 3365 | The billing page shows included, extra, in use, the per-seat price and plan + seats + VAT = monthly total, in Arabic and English | `tests/paid-seats-3360.test.ts` "the billing page card" | an end-to-end check of the page in RTL |
| 3366 | An invite over the limit is refused unless the body carries `addSeat: true` (the boolean only); the 409 carries `included, extra, unitSar, canBuy` | `tests/paid-seats-3360.test.ts` "over the limit without the confirm flag", "the route" | none |
| 3367 | A seat is bought only when the plan sells seats, billing is not locked and exactly one seat is missing | `tests/paid-seats-3360.test.ts` "exactly one seat short", "Agency and a locked bill" | none |
| 3368 | `billing.seats`: the owner's own session only, never an admin, the founder impersonating (`IMPERSONATION_BLOCKED`) or a token | `tests/paid-seats-3360.test.ts` "who may buy" | none |
| 3369 | The owner confirms in the UI ("adds 25 SAR/month + VAT", timing, leave rule) before `addSeat: true` is sent; the answer says `seatAdded` | server side in `tests/paid-seats-3360.test.ts` "the route"; `teamPerms.buySeats` in `tests/teams-ui.test.ts` | a component test of the TeamPanel confirm step |
| 3370 | The seat is usable at once and charged from the next renewal, no proration | `tests/paid-seats-3360.test.ts` (limit rises on confirm; renewal charges it) | none |
| 3371 | A leave, removal or cancelled invite changes nothing mid-period; `settleExtraSeats` at renewal lowers `extraSeats` to min(stored, billable) and never raises it | `tests/paid-seats-3360.test.ts` "leaving and renewal" | none |
| 3372 | The renewal charges (plan or locked price) + seats × 25 + VAT, stores `extraSeats` on the intent, and the callback's amount check includes them; a checkout never adds seats | `tests/paid-seats-3360.test.ts` (priceFor, `renewPaymob` with the Paymob fake) | none |
| 3373 | Concurrent invites cannot oversell: the purchase runs under `lock:team:{aid}` then `lock:user` and re-checks | `tests/paid-seats-3360.test.ts` "concurrent invites" | none |
| 3374 | Tenant scope: a purchase or a settle only touches the caller's account (`acct(u)`), never one named in the request | `tests/paid-seats-3360.test.ts` "tenant scope" | none |
| 3375 | The console Workspace tab shows included and extra seats, read only; staff cannot add a paid seat | `IMPERSONATION_BLOCKED` in `tests/paid-seats-3360.test.ts`; the view itself not pinned | a test of `workspaceView(...).plan.seats` |
| 3376 | Geidea renews through the same `renewPaymob`: it settles, prices and stores the seats on the intent, so the callback amount check includes them | `tests/geidea.test.ts` "a renewal with paid extra seats" | none |
| 3377 | Seats on a hand-set plan are counted and shown but charged by no code; the founder invoices them | not pinned | none (documented decision) |
| 3378 | A refund that ends the plan, or a founder change to a plan that sells no seats, clears `extraSeats` | not pinned | a test in `tests/paymob.test.ts` refund and `admin/plan` change |
| 3379 | The privacy export carries `extraSeats` with the plan | `tests/profile-allowlist.test.ts` (field listed) | an assertion on the export's plan block |
