# Partner programme and 15% first-month discounts (2026-10-01)

Status: built on branch `claude/launch-affiliates`. Rules 390-402 in `docs/system/tests.md`, pinned by `tests/partners.test.ts`. Flow: `docs/system/flows.md` section 46.

## 1. Decisions (the founder's, 2026-10-01, final)

| Topic | Decision | Where it lives in code |
|---|---|---|
| Commission | 15% of each payment a referred customer makes, for that customer's first 4 months of paid subscription | `COMMISSION_PCT`, `COMMISSION_MONTHS` in `src/lib/partner-rules.ts` |
| Attribution | Counts only if the customer's first payment is within 30 days of attribution (link cookie or code). Otherwise it lapses for commission; the record is kept | `ATTRIBUTION_DAYS`, `attributionDeadline`, `commissionDecision` |
| Payouts | Monthly bank transfer, from a SAR 200 balance; the founder pays by hand and marks it paid | `PAYOUT_MIN_SAR`, `payoutProblem`, `recordPayout` |
| Codes | One per partner, chosen or edited by the founder (suggested from the name), A-Z 0-9, 3-16, unique, reserved words refused | `CODE_RE`, `RESERVED_CODES`, `suggestCode`, `approvePartner` |
| Customer discount | A partner's code gives 15% off the first month | `FIRST_MONTH_DISCOUNT_PCT`, `firstMonthPriceSar` in `src/lib/pricing.ts` |
| Early-partner offer | The trial's last day offers 15% off the first month only | `earlyOfferDue`, `lastDayOfferOwed`, `grantEarlyOffer` |
| Stacking | Never: at most one 15% first-month discount per account, first paid month only | `User.firstMonthOffer` (one field), `openOffer` |
| Self-referral | Not counted: the partner's own account, or either account on the other's team roster | `commissionDecision` (`self`, `team`), `claimPartnerCode` |
| Partner login | A normal Thakeen account; the founder links the approval to the applicant's email | `partner:{email}`, `User.partnerCode` |

Precise windows (UTC calendar days, the payment's date as the founder enters it):

- Attribution: the first payment must be dated on or before the attribution day + 30 days (attributed 2026-10-01 at any hour: a payment dated 2026-10-31 counts, 2026-11-01 does not).
- Commission months: payments dated before the first payment's day-of-month 4 calendar months later count, clamped to the end of that month (first payment 2026-10-15: up to 2027-02-14; first payment 2026-10-31: up to 2027-02-27). With monthly billing that is the first four payments.
- Lapsed is decided by the first payment: once it is late, no later payment of that customer counts.

## 2. Payments are manual

There is no payment gateway. Plans are activated in the founder console (`POST /api/admin/plan`); the billing page shows the fixed `PAY_LINK_*` links or WhatsApp. So:

- A fixed-price link cannot carry a discount. While an account has an open offer, each self-serve card shows "15% off your first month: {list less 15%, nearest riyal} instead of {list}, plus VAT" and sends the owner to WhatsApp with that amount; the pay link stays as "pay the full price".
- The founder records each payment received in the console (amount in SAR excluding VAT, plan, date, reference). That record is the source of truth for commissions. The first one recorded uses the offer.
- Commissions are payable immediately; the founder voids a payment that was refunded or entered by mistake, which voids its commission.

## 3. Data model

On the account (`User`, `src/lib/auth.ts`, written under `withUserLock`):

- `referredBy {partner, code, at, via: "code" | "link"}`: first touch, never rewritten. Not sent to the customer's browser (`GET /api/profile` strips it).
- `firstMonthOffer {kind: "partner" | "early", pct, at, usedAt?, paymentId?}`: the account's one discount.
- `firstPaidOn`: the day of the first recorded payment that still stands.
- `partnerCode`: this account is a partner (shows the sidebar entry; the record is `partner:{email}`).

Keys (`src/lib/partners.ts`): `partner:{email}` (name, code, approval, bank details), `partnercode:{CODE}`, `partners:all`, `partner:refs:{email}` (customers attributed), `partner:ledger:{email}` (hash: `c:{paymentId}` commission, `p:{payoutId}` payout), `payments:{email}` (hash of recorded payments), `affiliate-applications` (list) and `affiliate:decisions` (hash). Locks: `lock:partners` (approvals), `lock:partner:{email}` (ledger and record; owned locks), and the customer's `lock:user:{email}`. Order is always customer then partner. Money is summed in halalas.

## 4. Flows and routes

| Step | Route | Who |
|---|---|---|
| Apply | `POST /api/affiliates` (existing form; applications now carry an id) | public, 10 per IP per hour |
| Approve, reject, mark payout paid | `GET/POST /api/admin/partners` | founder |
| Record or void a payment | `GET/POST /api/admin/payments/{email}` | founder |
| Partner link | `GET /p/{CODE}` → cookie `nashr_partner` (httpOnly, 30 days, first touch) → `/{lang}/app/signup?partner=CODE` | public, 60 per IP per hour |
| Signup | `POST /api/auth/signup` with optional `partnerCode` (typed wins over the cookie) | public |
| Code on the billing page | `POST /api/partner/code` | owner (`billing`), 10 per hour |
| Partner page | `/{lang}/app/partner` | owner (`partner`) |
| Bank details | `PUT /api/partner` | owner (`partner.bank`), refused while impersonating, 10 per hour |
| Early offer | daily cron (when the day-3 note is due) and the billing page (trial on or past its last day) | system / owner |

The credits referral (`/app/refer`, `?ref=`, `ref:{CODE}`, 50 credits each side) is separate and unchanged; partner codes may not equal a credits code.

## 5. Permissions

New actions in `src/lib/roles.ts`: `partner` (owner) and `partner.bank` (owner, impersonation-blocked). A member of a partner's account sees the owner-only note and no data. The partner sees referrals as `C-` plus a hash label, signup day, status (trial, paid, lapsed) and months counted, never a customer's name or email; the IBAN masked. The founder console shows the IBAN in full; it is never logged.

## 6. Open questions (for the founder; not decided here)

1. Once VAT is collected: is the 15% first-month discount, and the 15% commission base, computed before or after VAT? Today both use the amount excluding VAT, as every price on the site.
2. Should the early-partner offer expire? Today it has no expiry, and a trial that ended before 2026-10-01 is granted it when its owner opens the billing page.
3. Partner payouts: tax treatment and invoices (does a partner invoice Thakeen, is withholding needed).
4. Should partners accept programme terms (a checkbox) when applying? The form has none today.

## 7. Not built

- A payment gateway, so no automatic payment recording or refunds: every payment and void is entered by the founder.
- Pausing or closing a partner, changing a partner's code, or paying out a balance below SAR 200 when a partner leaves.
- Click counts for partner links (a click writes only the visitor's cookie).
- Partner notifications (email or in-app) about new referrals or commissions.
