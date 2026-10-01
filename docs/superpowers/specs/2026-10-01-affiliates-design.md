# Partner programme and 15% first-month discounts (2026-10-01)

Status: built on branch `claude/launch-affiliates`. Rules 390-417 in `docs/system/tests.md`, pinned by `tests/partners.test.ts`. Flow: `docs/system/flows.md` section 46. The founder's four open questions were answered on 2026-10-01 (section 6) and built as rules 409-414; the review that followed added rules 415-417 (consent carried onto the partner at approval, VAT registration as the partner's own answer, payout tax fields refused rather than dropped).

## 1. Decisions (the founder's, 2026-10-01, final)

| Topic | Decision | Where it lives in code |
|---|---|---|
| Commission | 15% of each payment a referred customer makes, for that customer's first 4 months of paid subscription, on the payment before VAT | `COMMISSION_PCT`, `COMMISSION_MONTHS`, `commissionSar` in `src/lib/partner-rules.ts` |
| Attribution | Counts only if the customer's first payment is within 30 days of attribution: the click on the partner's link (the cookie carries the click time), or the signup with a typed code. Otherwise it lapses for commission; the record is kept. A customer who paid before being referred is never the partner's | `ATTRIBUTION_DAYS`, `parsePartnerCookie`, `signupPartner`, `attributionDeadline`, `commissionDecision` |
| Payouts | Monthly bank transfer, from a SAR 200 balance; the founder pays by hand and marks it paid, only to bank details he confirmed with the partner; a mistaken entry is voided | `PAYOUT_MIN_SAR`, `payoutProblem`, `recordPayout`, `voidPayout`, `confirmBank` |
| Codes | One per partner, chosen or edited by the founder (suggested from the name), A-Z 0-9, 3-16, unique, reserved words refused | `CODE_RE`, `RESERVED_CODES`, `suggestCode`, `approvePartner` |
| Customer discount | A partner's code gives 15% off the first month, taken off the price before VAT; VAT is then computed on the discounted price | `FIRST_MONTH_DISCOUNT_PCT`, `firstMonthPriceSar` in `src/lib/pricing.ts`; the billing card says so (`OFFER_COPY.vat`) |
| Early-partner offer | The trial's last day offers 15% off the first month only. It ends 7 days after the trial's last day: after that it is neither shown nor granted nor applied, unless a recorded payment already took it. The billing card shows the end date | `EARLY_OFFER_DAYS`, `trialLastDay`, `earlyOfferLastDay`, `openOffer`, `offerLastDay`, `earlyOfferDue`, `lastDayOfferOwed`, `grantEarlyOffer` |
| Stacking | Never: at most one 15% first-month discount per account, first paid month only | `User.firstMonthOffer` (one field), `openOffer` |
| Self-referral | Not counted: the partner's own account, or either account on the other's team roster | `commissionDecision` (`self`, `team`), `claimPartnerCode` |
| Partner login | A normal Thakeen account; the founder links the approval to the applicant's email | `partner:{email}`, `User.partnerCode` |
| Countries | Open to all countries. Any country's IBAN (ISO 13616: an ISO 3166 code, the registry length for common countries with all six GCC states, mod-97), the country the partner lives in, an optional VAT or tax registration number, and a separate "I am VAT-registered" box that needs the number (rule 416) | `validIban`, `IBAN_LENGTHS`, `COUNTRY_CODES`, `validCountry`, `taxNumberOf`, `saveBank` |
| Taxes | Thakeen bears them. A VAT-registered partner adds VAT on top of the commission and Thakeen pays it; where withholding tax applies (for example a non-resident partner) Thakeen bears it; the partner receives the full 15% and stays responsible for their own income tax. The console flags "VAT-registered: add VAT on payout" (only when the partner ticked the box: a tax number alone may be an income-tax id) and "Outside Saudi Arabia: withholding tax may apply — ask your accountant"; the payout form records the commission, the VAT paid on top and the withholding borne (both optional; text that is not a number is refused, never dropped: rule 417), date and reference. The taxes never change the balance. No rate is coded: the founder enters the amounts | `taxFlags`, `optionalTax`, `taxField`, `taxTotals`, `Payout.vatSar`, `Payout.whtSar`, `recordPayout` |
| Terms and consent | Public terms at `/{lang}/affiliates/terms` (Arabic and English, last updated 2026-10-01); the application form's box "I agree to the partner programme terms" is required, the API refuses an application without it (400) and stores the consent date and terms version; the founder console shows it. No partner without a recorded agreement (rule 415): approval copies the application's consent onto the partner, or records the founder's explicit statement that the applicant agreed outside the form (who and when, logged); otherwise 400 `no_consent`. The Partners tab shows each partner's agreement or flags its absence | `src/lib/partner-terms.ts`, `PARTNER_TERMS_VERSION`, `POST /api/affiliates`, `listApplications`, `approvePartner`, `Partner.terms` |

Precise windows (Riyadh calendar days, UTC+3, the payment's date as the founder enters it):

- Attribution moment: the click on the partner's link when the code that counts came from the link (`/p/{CODE}` stores `CODE.<click ms>` in the cookie and fills the code into the signup form; a typed code equal to the cookie's is the link's), else the signup with a typed code. A second click on any partner link never restarts the 30 days (first touch).
- Attribution: the first payment must be dated on or after the attribution day and on or before the attribution day + 30 days (attributed 2026-10-01 at any hour in Riyadh: a payment dated 2026-10-31 counts, 2026-11-01 does not; a click at 01:30 on 2026-10-02 in Riyadh, 22:30 UTC on 2026-10-01, is attributed on 2026-10-02). Click on day 0, signup on day 29, first payment on day 31: lapsed.
- Commission months: payments dated before the first payment's day-of-month 4 calendar months later count, clamped to the end of that month (first payment 2026-10-15: up to 2027-02-14; first payment 2026-10-31: up to 2027-02-27). With monthly billing that is the first four payments.
- Lapsed is decided by the first payment: once it is late, no later payment of that customer counts.
- The first payment is the earliest one that stands. Every payment's commission is re-taken whenever a payment is recorded or voided (`settle`), so a backdated entry or a voided first payment moves all of them with it; the payments whose answer changed are logged.

## 2. Payments are manual

There is no payment gateway. Plans are activated in the founder console (`POST /api/admin/plan`); the billing page shows the fixed `PAY_LINK_*` links or WhatsApp. So:

- A fixed-price link cannot carry a discount. While an account has an open offer, each self-serve card shows "15% off your first month: {list less 15%, nearest riyal} instead of {list}, plus VAT" and sends the owner to WhatsApp with that amount; the pay link stays as "pay the full price". The banner says the discount comes off the price before VAT and VAT is computed on the discounted price, and for the early-partner offer the day it ends ("ينتهي العرض في …").
- The founder records each payment received in the console (amount in SAR excluding VAT, plan, date, reference). That record is the source of truth for commissions, which are taken on that amount before VAT. The first one recorded uses the offer; an early-partner offer only when the payment is dated on or before its last day (the day the money arrived counts, so a payment made in time and recorded later still uses it).
- Commissions are payable immediately; the founder voids a payment that was refunded or entered by mistake, which voids its commission.
- Payment records are written before ledger rows, and the ledger is compared with them on every change, so a request that fails halfway is repaired by the next one.
- Bank details: the partner's account may have been created after the approval by whoever signed up first with the approved address (signup does not verify the address). So no payout is marked paid until the founder confirms the holder and IBAN with the partner out of band (by phone, from the application), and every change by the partner clears that confirmation. The console flags an account created after the approval.

## 3. Data model

On the account (`User`, `src/lib/auth.ts`, written under `withUserLock`):

- `referredBy {partner, code, at, via: "code" | "link", ref}`: first touch, never rewritten; `at` is the link's click or the signup; `ref` is 12 random hex characters, the only source of the partner's label. Not sent to the customer's browser (`GET /api/profile` strips it).
- `firstMonthOffer {kind: "partner" | "early", pct, at, usedAt?, paymentId?}`: the account's one discount.
- `firstPaidOn`: the day of the first recorded payment that still stands.
- `partnerCode`: this account is a partner (shows the sidebar entry; the record is `partner:{email}`).

Keys (`src/lib/partners.ts`): `partner:{email}` (name, code, approval, `hadAccount`, `terms {at, version, via: "application" | "founder", by?}`, bank details with the partner's `country`, optional `taxNumber`, `vatRegistered`, `savedAt` and `confirmedAt`), `partnercode:{CODE}`, `partners:all`, `partner:refs:{email}` (customers attributed), `partner:ledger:{email}` (hash: `c:{paymentId}` commission with the customer's label, never the email; `p:{payoutId}` payout with optional `vatSar` and `whtSar`, `voidedAt` when entered by mistake), `payments:{email}` (hash of recorded payments), `affiliate-applications` (list; since the terms, each with `consentAt` and `termsVersion`) and `affiliate:decisions` (hash). Locks: `lock:partners` (approvals), `lock:partner:{email}` (ledger and record; owned locks), and the customer's `lock:user:{email}`. Order is always customer then partner. Money is summed in halalas.

## 4. Flows and routes

| Step | Route | Who |
|---|---|---|
| Apply | `POST /api/affiliates` (existing form; applications now carry an id, and need the terms box: 400 `consent_required` without it) | public, 10 per IP per hour |
| Terms | `/{lang}/affiliates/terms` | public |
| Approve, reject, confirm bank details, mark payout paid (idempotent `po_` id), void a payout | `GET/POST /api/admin/partners` | founder |
| Record or void a payment | `GET/POST /api/admin/payments/{email}` | founder |
| Partner link | `GET /p/{CODE}` → cookie `nashr_partner` = `CODE.<click ms>` (httpOnly, 30 days, first touch) → `/{lang}/app/signup?partner=CODE` | public, 60 per IP per hour |
| Signup | `POST /api/auth/signup` with optional `partnerCode` (typed wins over the cookie) | public |
| Code on the billing page | `POST /api/partner/code` | owner (`billing`), 10 per hour |
| Partner page | `/{lang}/app/partner` | owner (`partner`) |
| Bank details | `PUT /api/partner` | owner (`partner.bank`), refused while impersonating, 10 per hour |
| Early offer | daily cron (when the day-3 note is due) and the billing page (from the trial's last day through the offer's last day, 7 days after it; never while the founder impersonates) | system / owner |

The credits referral (`/app/refer`, `?ref=`, `ref:{CODE}`, 50 credits each side) is separate and unchanged; partner codes may not equal a credits code.

## 5. Permissions

New actions in `src/lib/roles.ts`: `partner` (owner) and `partner.bank` (owner, impersonation-blocked). A member of a partner's account sees the owner-only note and no data. The partner sees referrals as `C-` plus six characters of the random `ref`, signup day, status (trial, paid, lapsed), months counted and payment amounts, never a customer's name or email; the IBAN masked, and whether we still have to confirm it. The founder console shows the IBAN in full and maps labels of current referrals to emails; it is never logged. The privacy policy (`src/lib/legal.ts`) states the cookie, the partner's view, the bank details, and since rules 411-416 the partner's country, optional tax number and whether they said they are VAT-registered, the VAT and withholding recorded with each transfer, and the application's terms consent (date and version).

## 6. The founder's questions, answered (2026-10-01, final)

1. VAT. Answered: the commission base and the first-month discount are computed before VAT. The discount comes off the pre-VAT price and VAT is then computed on the discounted price; the commission is 15% of the payment excluding VAT. It already worked this way; the code comments, this spec, the public terms and the billing card now say so (rule 409).
2. Early-partner offer expiry. Answered: it ends 7 days after the trial's last day (Riyadh days). After that it is neither shown nor applicable, unless a recorded payment already took it; a payment dated on or before the last day still uses it. The billing page makes up a missed grant only inside that window (before: up to 3 days after the trial ended, with no end date on the offer once granted); a trial whose window has passed never gets it. An early offer that ended unused gives way to a partner code the owner takes afterwards (a running one is kept: never stacked). The billing card and the day-3 email show the end date (rule 410).
3. Countries and taxes. Answered: partners are open to all countries. The Saudi-only IBAN check is replaced by a generic one, with the partner's country and an optional VAT or tax registration number (rule 411). Thakeen bears the taxes: VAT a VAT-registered partner adds on top, and withholding tax where it applies; the partner receives the full 15% and stays responsible for their own income tax. The console flags each case and the payout form records the VAT paid and the withholding borne for the books, without changing the balance; no tax rate is coded (rule 412).
4. Terms and consent. Answered: public terms at `/{lang}/affiliates/terms` (rule 413), and a required box on the application, refused without it and stored with its date and terms version `2026-10-01` (rule 414). Applications sent before the box existed show no consent in the console, and those sent before 2026-10-01 are still marked as made under the old terms. Approving one of those (or approving by email with no application) needs the founder to tick that the applicant agreed outside the form; the agreement is kept on the partner record either way (rule 415).

## 7. Not built

- A payment gateway, so no automatic payment recording or refunds: every payment and void is entered by the founder.
- Pausing or closing a partner, changing a partner's code, or paying out a balance below SAR 200 when a partner leaves.
- Click counts for partner links (a click writes only the visitor's cookie).
- Partner notifications (email or in-app) about new referrals or commissions.
- Tax computation and partner invoices: the founder enters the VAT paid and withholding borne as amounts; no rate is coded and no invoice is generated.
- Top-ups as commissionable payments: the credit top-ups (PR "Credit top-ups", branch `claude/launch-topups`, being built) should count as customer payments for commission once both are merged. Follow-up.
