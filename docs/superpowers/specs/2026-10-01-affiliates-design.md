# Partner programme and 15% first-month discounts (2026-10-01)

Status: built on branch `claude/launch-affiliates`. Rules 390-408 in `docs/system/tests.md`, pinned by `tests/partners.test.ts`. Flow: `docs/system/flows.md` section 46.

## 1. Decisions (the founder's, 2026-10-01, final)

| Topic | Decision | Where it lives in code |
|---|---|---|
| Commission | 15% of each payment a referred customer makes, for that customer's first 4 months of paid subscription | `COMMISSION_PCT`, `COMMISSION_MONTHS` in `src/lib/partner-rules.ts` |
| Attribution | Counts only if the customer's first payment is within 30 days of attribution: the click on the partner's link (the cookie carries the click time), or the signup with a typed code. Otherwise it lapses for commission; the record is kept. A customer who paid before being referred is never the partner's | `ATTRIBUTION_DAYS`, `parsePartnerCookie`, `signupPartner`, `attributionDeadline`, `commissionDecision` |
| Payouts | Monthly bank transfer, from a SAR 200 balance; the founder pays by hand and marks it paid, only to bank details he confirmed with the partner; a mistaken entry is voided | `PAYOUT_MIN_SAR`, `payoutProblem`, `recordPayout`, `voidPayout`, `confirmBank` |
| Codes | One per partner, chosen or edited by the founder (suggested from the name), A-Z 0-9, 3-16, unique, reserved words refused | `CODE_RE`, `RESERVED_CODES`, `suggestCode`, `approvePartner` |
| Customer discount | A partner's code gives 15% off the first month | `FIRST_MONTH_DISCOUNT_PCT`, `firstMonthPriceSar` in `src/lib/pricing.ts` |
| Early-partner offer | The trial's last day offers 15% off the first month only | `earlyOfferDue`, `lastDayOfferOwed`, `grantEarlyOffer` |
| Stacking | Never: at most one 15% first-month discount per account, first paid month only | `User.firstMonthOffer` (one field), `openOffer` |
| Self-referral | Not counted: the partner's own account, or either account on the other's team roster | `commissionDecision` (`self`, `team`), `claimPartnerCode` |
| Partner login | A normal Thakeen account; the founder links the approval to the applicant's email | `partner:{email}`, `User.partnerCode` |

Precise windows (Riyadh calendar days, UTC+3, the payment's date as the founder enters it):

- Attribution moment: the click on the partner's link when the code that counts came from the link (`/p/{CODE}` stores `CODE.<click ms>` in the cookie and fills the code into the signup form; a typed code equal to the cookie's is the link's), else the signup with a typed code. A second click on any partner link never restarts the 30 days (first touch).
- Attribution: the first payment must be dated on or after the attribution day and on or before the attribution day + 30 days (attributed 2026-10-01 at any hour in Riyadh: a payment dated 2026-10-31 counts, 2026-11-01 does not; a click at 01:30 on 2026-10-02 in Riyadh, 22:30 UTC on 2026-10-01, is attributed on 2026-10-02). Click on day 0, signup on day 29, first payment on day 31: lapsed.
- Commission months: payments dated before the first payment's day-of-month 4 calendar months later count, clamped to the end of that month (first payment 2026-10-15: up to 2027-02-14; first payment 2026-10-31: up to 2027-02-27). With monthly billing that is the first four payments.
- Lapsed is decided by the first payment: once it is late, no later payment of that customer counts.
- The first payment is the earliest one that stands. Every payment's commission is re-taken whenever a payment is recorded or voided (`settle`), so a backdated entry or a voided first payment moves all of them with it; the payments whose answer changed are logged.

## 2. Payments are manual

There is no payment gateway. Plans are activated in the founder console (`POST /api/admin/plan`); the billing page shows the fixed `PAY_LINK_*` links or WhatsApp. So:

- A fixed-price link cannot carry a discount. While an account has an open offer, each self-serve card shows "15% off your first month: {list less 15%, nearest riyal} instead of {list}, plus VAT" and sends the owner to WhatsApp with that amount; the pay link stays as "pay the full price".
- The founder records each payment received in the console (amount in SAR excluding VAT, plan, date, reference). That record is the source of truth for commissions. The first one recorded uses the offer.
- Commissions are payable immediately; the founder voids a payment that was refunded or entered by mistake, which voids its commission.
- Payment records are written before ledger rows, and the ledger is compared with them on every change, so a request that fails halfway is repaired by the next one.
- Bank details: the partner's account may have been created after the approval by whoever signed up first with the approved address (signup does not verify the address). So no payout is marked paid until the founder confirms the holder and IBAN with the partner out of band (by phone, from the application), and every change by the partner clears that confirmation. The console flags an account created after the approval.

## 3. Data model

On the account (`User`, `src/lib/auth.ts`, written under `withUserLock`):

- `referredBy {partner, code, at, via: "code" | "link", ref}`: first touch, never rewritten; `at` is the link's click or the signup; `ref` is 12 random hex characters, the only source of the partner's label. Not sent to the customer's browser (`GET /api/profile` strips it).
- `firstMonthOffer {kind: "partner" | "early", pct, at, usedAt?, paymentId?}`: the account's one discount.
- `firstPaidOn`: the day of the first recorded payment that still stands.
- `partnerCode`: this account is a partner (shows the sidebar entry; the record is `partner:{email}`).

Keys (`src/lib/partners.ts`): `partner:{email}` (name, code, approval, `hadAccount`, bank details with `savedAt` and `confirmedAt`), `partnercode:{CODE}`, `partners:all`, `partner:refs:{email}` (customers attributed), `partner:ledger:{email}` (hash: `c:{paymentId}` commission with the customer's label, never the email; `p:{payoutId}` payout, `voidedAt` when entered by mistake), `payments:{email}` (hash of recorded payments), `affiliate-applications` (list) and `affiliate:decisions` (hash). Locks: `lock:partners` (approvals), `lock:partner:{email}` (ledger and record; owned locks), and the customer's `lock:user:{email}`. Order is always customer then partner. Money is summed in halalas.

## 4. Flows and routes

| Step | Route | Who |
|---|---|---|
| Apply | `POST /api/affiliates` (existing form; applications now carry an id) | public, 10 per IP per hour |
| Approve, reject, confirm bank details, mark payout paid (idempotent `po_` id), void a payout | `GET/POST /api/admin/partners` | founder |
| Record or void a payment | `GET/POST /api/admin/payments/{email}` | founder |
| Partner link | `GET /p/{CODE}` → cookie `nashr_partner` = `CODE.<click ms>` (httpOnly, 30 days, first touch) → `/{lang}/app/signup?partner=CODE` | public, 60 per IP per hour |
| Signup | `POST /api/auth/signup` with optional `partnerCode` (typed wins over the cookie) | public |
| Code on the billing page | `POST /api/partner/code` | owner (`billing`), 10 per hour |
| Partner page | `/{lang}/app/partner` | owner (`partner`) |
| Bank details | `PUT /api/partner` | owner (`partner.bank`), refused while impersonating, 10 per hour |
| Early offer | daily cron (when the day-3 note is due) and the billing page (trial in its last day or ended less than 3 days ago; never while the founder impersonates) | system / owner |

The credits referral (`/app/refer`, `?ref=`, `ref:{CODE}`, 50 credits each side) is separate and unchanged; partner codes may not equal a credits code.

## 5. Permissions

New actions in `src/lib/roles.ts`: `partner` (owner) and `partner.bank` (owner, impersonation-blocked). A member of a partner's account sees the owner-only note and no data. The partner sees referrals as `C-` plus six characters of the random `ref`, signup day, status (trial, paid, lapsed), months counted and payment amounts, never a customer's name or email; the IBAN masked, and whether we still have to confirm it. The founder console shows the IBAN in full and maps labels of current referrals to emails; it is never logged. The privacy policy (`src/lib/legal.ts`) states the cookie, the partner's view and the bank details.

## 6. Open questions (for the founder; not decided here)

1. Once VAT is collected: is the 15% first-month discount, and the 15% commission base, computed before or after VAT? Today both use the amount excluding VAT, as every price on the site.
2. Should the early-partner offer expire? Today a granted offer has no expiry. It is granted on the trial's last day (the cron) or when the owner opens billing within 3 days after the trial ended; should trials that ended earlier (before 2026-10-01 included) get it too? Today they do not.
3. Partner payouts: tax treatment and invoices (does a partner invoice Thakeen, is withholding needed).
4. Should partners accept programme terms (a checkbox) when applying? The form has none today. Applications sent before 2026-10-01 were made under the old public terms (25% recurring, 60 days): the console marks them, and the founder tells those applicants the new terms before approving.

## 7. Not built

- A payment gateway, so no automatic payment recording or refunds: every payment and void is entered by the founder.
- Pausing or closing a partner, changing a partner's code, or paying out a balance below SAR 200 when a partner leaves.
- Click counts for partner links (a click writes only the visitor's cookie).
- Partner notifications (email or in-app) about new referrals or commissions.
