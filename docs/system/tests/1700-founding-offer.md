# Coverage: the founding offer and the price lock (rules 1700-1712)

Status on 2026-10-13 on branch `claude/founding-mechanics-c7c7d2` (cut from `main` 28e784d5). Founder decision 2026-10-13: build the founding offer in code. Sources: PRD `docs/PRD-Thakeen.md` 11.2-11.3, spec `docs/specs/2026-10-13-founding-20-seats-price-lock.md`, `docs/system/flows.md` section 72. Off until Paymob is on (`paymobConfig()`); no new environment variable. Rules 1713-1719 are held for this change and not used. Expand step (rule 679): two optional fields on the account (`founding`, `priceLock`) and two on a Paymob intent (`founding`, `lockedBaseHalalas`); old code ignores them and keeps them on save; no conversion script; the contract step is not needed (nothing old is removed).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1700 | The seat counter is one Redis step: `db.zaddCapped(key, score, member, max)` (Lua: ZSCORE, ZCARD, ZADD) answers the new count, `full` at the cap or `exists` for a member already in. 25 concurrent claims for 20 seats give exactly 20; a repeat never counts twice | `tests/founding.test.ts` (rule 1700) | — |
| 1701 | The numbers are constants in `src/lib/founding.ts`: 20 seats, 12 months for a seat, 6 months after, 100 accounts, 7 days, sale from 2026-11-01 (Riyadh day). The 100 is unverified against the PRD | `tests/founding.test.ts` (rule 1701) | — |
| 1702 | Checkout: a `founding: true` request becomes a founding intent only when the sale has started, a seat is free, and the account has no seat, no lock and no online subscription; otherwise the intent is ordinary | `tests/founding.test.ts` (rule 1702) | — |
| 1703 | A paid founding first month (the callback, under the account's lock, first online subscription only) takes a seat and a 12-month lock at the list price before VAT; one console line; a replayed callback takes nothing more. Before the sale nothing is taken | `tests/founding.test.ts` (rule 1703) | — |
| 1704 | A founding payment that finds no seat left is an ordinary subscriber with the 6-month lock, and the log line says `seat:full` | `tests/founding.test.ts` (rule 1704) | — |
| 1705 | An ordinary first payment takes a 6-month lock while fewer than 100 accounts hold one, none after; a founding seat's lock is never refused | `tests/founding.test.ts` (rule 1705) | — |
| 1706 | The renewal charges min(locked, list) before VAT while the lock is live, on the same plan, and the period starts before `until`; the intent stores the figure and the callback is checked against it. Another plan, an ended or bad lock, or no lock: the list price as before. A first month is never locked | `tests/founding.test.ts` (rule 1706) | — |
| 1707 | The 7-day refund proposal: paid − used credits × (price before VAT ÷ monthly credits), floor, between 0 and paid; day 7 after the payment day inside, day 8 outside. Shown to the founder only; the refund itself stays the full refund | `tests/founding.test.ts` (rule 1707) | — |
| 1708 | A full refund that ends the plan (rule 1300) ends the seat and the lock and frees both places; the account never claims again on its own | `tests/founding.test.ts` (rule 1708) | — |
| 1709 | `GET /api/admin/founding`: founder only (401); counts, each account's seat, lock and refund proposal | `tests/founding.test.ts` (rules 1709, 1710), `tests/role-gates.test.ts` | — |
| 1710 | `POST /api/admin/founding`: founder, second factor, a reason; grant or end a seat or a lock under the account's lock; 404 for no account, 409 for a duplicate or nothing live or seats full, 400 for a bad plan or day; one audit row each; ending frees the place | `tests/founding.test.ts` (rules 1709, 1710), `tests/role-gates.test.ts` | The second-factor 403 on this route (covered generically for console writes by the second-factor tests, not here) |
| 1711 | `GET /api/founding/seats`: public, rate limited per IP (60 a minute); closed while payment is off, before the sale and at zero seats; otherwise seats left and total, never an email | `tests/founding.test.ts` (rule 1711), `tests/role-gates.test.ts` | — |
| 1712 | Deleting the account frees both places; the data download shows the seat and the lock | `tests/founding.test.ts` (rule 1712), `tests/profile-allowlist.test.ts` | — |

Deviations from the spec, decided by default and listed for the founder:

- The seat and the lock live on the account (`User.founding`, `User.priceLock`), not on `Billing`: `applyPaid` rebuilds `billing` and a refund deletes it, so a field there would be lost.
- The partner code's first-month discount still applies to a founding checkout; the PRD says the founding seats are sold at the full price with no discount. Open question.
- The refund proposal is a figure for the founder; a partial refund through Paymob is not built (needs test mode).
- No customer-facing text: the pricing-page line and the "price fixed until" notice on the billing page wait for the founder's wording. The public counter has no reader yet.
- A seat claimed in Redis for an account whose save then failed cannot be freed from the console yet (it shows as "no account record").
