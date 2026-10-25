# Paid extra seats

Date: 2026-10-23. Branch: `claude/sup-paid-seats`. Rules 3360-3379 (`docs/system/tests/3360-paid-seats.md`). Flow: `docs/system/flows.md` section 121. Reference read only: supastarter's per-seat billing (seat count follows members, charged with the subscription).

## Decision (founder)

25 SAR per extra seat per month, before VAT, above each plan's included seats. VAT is added like a plan's. The charge follows the seat count.

## Design

- **Price.** `EXTRA_SEAT_MONTHLY_SAR = 25` in `src/lib/pricing.ts`, the only place. `extraSeatsLine(n)` and `monthlyTotal(u)` give halalas with VAT on the sum. No yearly interval: a year is 12 monthly charges.
- **Stored shape (expand).** `User.extraSeats?: number`. Absent = 0. Read only through `paidExtraSeats(u)` (0 for a plan that sells no seats, junk or absent; floored; capped at `MAX_SEAT_OVERRIDE`). `seatLimit(u) = includedSeats(u) + paidExtraSeats(u)`; `includedSeats` keeps the founder's `seats` override, Agency's 7 and `PLAN_SEATS`.
- **Count.** Used = M3's `seatCount(members, invites)` in `src/lib/team.ts` (rule 3753): owner + admins + Editors not paused + pending invites, with the first `FREE_VIEWERS` (3) Viewers free; this branch sits on M3 (`claude/m3-customer-roles-b97625`) and has no count of its own. Every limit check, the renewal settle, the Members and billing pages and the console call it, so a free Viewer is never billed and the 4th Viewer is one paid seat. `enforceSeats` is M3's. Pending invites count because an invite already holds a seat and accepting never buys one. Billable = max(0, used − included).
- **Who buys.** The owner's own session (`billing.seats`, `kind: "owner"` only; in `IMPERSONATION_BLOCKED`). Plans starter, pro and business. Not a trial (it would mean paying before the plan), not Agency (sized by the founder), not a locked bill. Exactly one seat short, so a downgraded team over its limit is never fitted by one click.
- **Purchase.** `POST /api/team/invite {…, addSeat: true}`. Without the boolean: 409 `seats` with `included, extra, unitSar, canBuy`. The Members page shows a confirm dialog (Arabic and English) and resends with `addSeat: true`. `createInvite` checks under `lock:team:{aid}`, then `addPaidSeat` re-reads under `lock:user` and raises `extraSeats` by one. Concurrent invites serialize on the team lock.
- **Timing.** Usable now, charged from the next renewal, no proration: the billing seam has no safe mid-period charge (checkout is interactive, the saved card is merchant-initiated on the renewal day only, and Paymob is gated off today).
- **Leave or cancel.** No change mid-period, no refund. `settleExtraSeats` at the renewal lowers `extraSeats` to min(stored, billable now), never raises it.
- **Renewal.** `renewPaymob` settles first, then `chargeSavedCard` charges `priceFor("renewal", {plan, extraSeats})` = (plan or locked price + seats × 25) + VAT and stores `extraSeats` on the intent; the callback's amount check recomputes it. A checkout (first payment, plan switch) never includes seats.
- **Geidea.** On local branches only. Its renewal must call `settleExtraSeats`, charge `priceFor("renewal", {plan, extraSeats})` and store `extraSeats` on its intent (`TODO(geidea)` in `billing.ts`).
- **Screens.** Billing page card (`SeatsBillingCard`): included, extra, in use, unit price, plan + seats + VAT = total. Members page: used/available, paid seats line, confirm step. Console Workspace tab: included and extra, read only.

## Open items for the founder

1. Starter includes 1 seat (the owner), so a starter owner's first invite is a paid seat. Confirm, or raise Starter's included seats.
2. A seat added and freed within one period is never charged (charge at renewal only). Accept, or add a minimum term.
3. Hand-set plans: seats are counted and shown, not charged by code; invoice by hand.
4. Partner commission is computed on the charged amount, so it includes seats on renewals. Confirm.
5. A first checkout or plan switch does not include seats; they start on the next renewal.
6. No team-log row for a seat purchase (server log only), to avoid a stored-shape change now.

## Release

Expand only. Old code ignores `extraSeats`; on a rollback a team with paid seats reads as over its limit (like a downgrade) and new invites are refused until a seat frees. Contract step: none planned.
