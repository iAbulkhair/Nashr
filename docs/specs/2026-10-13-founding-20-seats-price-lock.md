# Founding 20: seat counter, 12-month price lock, 7-day refund

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 8 of 8, after Paymob is switched on (the `PAYMOB_*` keys are not set). Rule numbers are assigned when it is built. Source of the decisions: `docs/PRD-Thakeen.md` sections 11.2 and 11.3 (founder, 2026-10-05).

## ملخص

قرار المؤسس: يبدأ البيع في 1 نوفمبر 2026 بعرض «20 مقعداً مؤسساً» بالسعر الكامل بلا خصم. مزايا المؤسسين: تثبيت السعر الشهري 12 شهراً (والمشتركون بعد المؤسسين 6 أشهر بحسب القسم 11.2)، جلسة تأسيس شخصية، تصويت شهري على الميزة التالية، شارة «مؤسس» (يظهر الاسم بموافقة العميل فقط). الدفع أولاً ثم الاستخدام، مع ضمان استرجاع 7 أيام: كامل إن لم يستهلك شيئاً، وإلا يُخصم من المبلغ قيمة الرصيد المستهلك. المطلوب بناؤه: (1) عدّاد مقاعد صادق (يظهر فقط ما هو حقيقي)، (2) علامة «مؤسس» على الحساب مع تاريخ نهاية تثبيت السعر يُحترم عند التجديد حتى لو تغيّر سعر الباقة، (3) استرداد جزئي محسوب. اليوم الاسترداد عبر Paymob كامل فقط، والاسترداد الجزئي يحتاج بناءً. لا يُبنى قبل تشغيل Paymob. قرارات مفتوحة للمؤسس في آخر الوثيقة.

## Goal

1. Sell the first twenty seats on the terms the founder decided, with a counter that is true.
2. Keep a founder's monthly price fixed for twelve months, in code, not in a promise.
3. Honour the seven-day guarantee with a calculation the founder can check, not a hand-made number.

## Today (checked 2026-10-13)

- Prices are constants: `PLAN_PRICE_SAR` Starter 299, Pro 499, Business 999 (`src/lib/pricing.ts`); VAT and halalas come from `priceFor` in `src/lib/billing.ts`. A renewal recomputes the price from the plan (`priceFor("renewal", { plan })`), so a future price change would reach every subscriber. There is no lock.
- `Billing` (`src/lib/billing-state.ts`) holds plan, status, `paidThrough`, `anchor`, `autoRenew`, `failures`, `card`, `pending`, `txns`. No founder flag, no price.
- Refund: `refundPaymobPayment` (founder console route `/api/admin/payments/[email]`) refunds the whole Paymob transaction once, voids the payment and ends the plan (`endPlanOnRefund`, rule 1300). A partial refund made in Paymob's own dashboard changes nothing on the account (rule 1301). The route takes a reason (rule 1185), needs the second factor and writes through `adminAudit`.
- No seat counter, no founder badge, no founder offer page. Online payment is off (no `PAYMOB_*` keys), so nothing is sold online yet. Trial length in code is still 3 days; the decision is 7 (Owner list), and the PRD says the 7-day trial stays for people after the founders.

## User flow

1. Pricing page (public) shows, while seats remain, "Founding seats: N of 20 left" / «المقاعد المؤسسة: بقي N من 20». N is read from the real count of founder accounts. When none remain the line is removed (never left at 0, never a fake count). Before the sale starts (before 1 November 2026 Riyadh time) the line is absent.
2. A visitor who signs up while seats remain and pays the first month with the founder-offer link gets the founder flag on payment success (the Paymob callback), not on a button press. The seat is taken at the moment a payment is applied; a second payment arriving when the twentieth seat is gone is applied as an ordinary subscription, never as a founder one, and the founder is told in the console.
3. The customer sees in billing: "Your price is fixed at SAR X until <date>" and, after that date, the ordinary price with a notice sent one month before the lock ends.
4. Refund inside seven days of the first payment: the customer writes to hello@thakeen.com (or presses "Request refund" on the billing page, which only creates a request for the founder). The founder opens the payment in the console and sees a proposed amount: the price paid minus the value of credits used (rule below). The founder confirms with a reason; the system refunds that amount at Paymob, ends the plan, and the customer gets the usual notice mail.
5. The founder badge (name shown only with consent) and the monthly vote are separate small features and are not part of this spec.

## Rules (constants in one file)

- Seats: 20, counted as accounts with `founder.seat` set. The count is a Redis counter incremented with an atomic guard so the twenty-first claim fails; the set of founder emails is kept in a hash for the console list.
- Lock: the monthly price at the time of the first payment, kept for 12 months from `paidAt`. The renewal charges `lockedPriceHalalas` while `now < lockUntil`, else the current price. The lock follows the plan the founder bought; changing plan during the lock is priced at the current price of the new plan (open decision 2).
- Refund calculation (proposed): amount = price paid including VAT, minus the cost value of credits used, where used credits are the credits spent since the payment and their SAR value is credits used times (price excluding VAT divided by the plan's monthly credits). If nothing was used, the full amount. Window: 7 days from the first payment, Riyadh days. Rounded down to a halala; never negative; never above what was paid.

## Data shape (rule 679: only new optional keys)

- `Billing.founder?: { seat: number; at: string; lockUntil: string; lockedHalalas: number }` (optional; old readers ignore it; the renewal reads it when present).
- `founders:seats` (Redis counter) and `founders:list` (hash email to `{ seat, at }`) for the counter and the console list. Derived values can be recounted from the list.
- `Payment.refund?: { amountHalalas: number; reason: string; by: string; at: string; partial: boolean }` (optional). A refund for part of a transaction is recorded so a retry cannot refund twice.
- `refunded:{txnId}` keeps its role as the once-only guard; it additionally records the amount.
- `wipeAccount` and the data download include the founder flag and the refund record.

## Routes and auth

- Public read `GET /api/founders/seats` returns `{ left, total, open }` only (no emails); rate limited (`src/lib/rate.ts`), cached briefly.
- Paymob callback (HMAC-verified with `sameSecret`, as today) claims a seat inside `withUserLock` when the intent carries the founder offer and the sale is open; the offer flag comes from our server-side intent record, never from the request.
- `POST /api/billing/refund-request` (`currentUser()`, caller's own scope): creates a request on the account; no money moves.
- Founder console: `GET /api/admin/founders` (list, seats left), `POST /api/admin/payments/[email]` extended with an optional `amountHalalas`, still `adminActor` then `secondFactorRefusal`, still `reasonRefused`, still `adminAudit`. The proposed amount is computed by the server and the founder may only lower it, not raise it above the computation.
- Documented in `permissions.md`, `flows.md` (billing section), `architecture.md`, `variables.md` (a sale start constant only; no new secrets).

## Environment variables

None new. The existing `PAYMOB_*` names (`PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID_CARD`, `PAYMOB_INTEGRATION_ID_MOTO`, `PAYMOB_LIVE`) must be set first. The sale start date and the seat total are code constants so a change is reviewed.

## Risks

- Money correctness: partial refunds are new. Paymob's partial-refund API call and its rounding must be confirmed in test mode before any live use; until then the console keeps the full-refund path only.
- Honesty: the counter must never show a number that is not the count; no "last seat" urgency text unless true. No invented customers or testimonials on the offer page.
- Race: two payments for the last seat. The atomic claim decides; the loser is told and treated as an ordinary subscriber.
- Lock vs legal text: the terms and privacy pages must state the lock, the refund window and the deduction exactly as built (lawyer item). Wording "pay first, 7 days" is the PRD decision; the text on the site is not changed until this is built.
- A customer who disputes the deduction: the console shows the usage figures used, and the refund record keeps them.
- Price changes while locked: the lock is a stored number, so a later price change does not move it; a test pins this.
- VAT: refunds of the VAT part follow the invoice rules (lawyer and accountant item).

## Test plan

- Seat claim: 20 succeed, the 21st fails, concurrent claims never exceed 20; a replayed callback does not take a second seat.
- Lock: renewal at month 2 and month 12 charges the locked amount after a constant change; month 13 charges the current price; a plan change inside the lock is priced as decided.
- Refund amount: nothing used gives full; some used gives the proportional deduction; day 7 included, day 8 refused; amount never above paid, never negative; rounding on halalas.
- Refund route: needs founder, second factor, reason; second call is a no-op; the plan ends; the founder cannot raise the amount.
- Counter route: no emails in the answer; absent before the sale start; rate limited.
- Tenant: the refund request touches only the caller's scope; the console reads accounts by listing.
- Old-shape read: an account without `founder` renews exactly as today.

## Open decisions for the founder (defaults in brackets)

1. PRD 11.2 says 12 months for founders and 6 months for those after them. [Founders 12 months only in v1; a 6-month lock for later customers is a separate decision and is not built here.]
2. A plan change inside the lock. [Upgrade at the current price of the new plan; downgrade keeps the lock on the new plan's original price only if lower.]
3. The sale start moment. [1 November 2026, 00:00 Riyadh time, as a code constant.]
4. Whether a refund request button exists or the customer must write by email. [Email only in v1.]
5. Who may see the founder list. [Founder only.]

## Rough size

Large because it touches money: counter and claim, lock in the renewal, partial refund with Paymob, console, public counter, docs and tests. Two pull requests: (a) lock and seat claim behind the offer flag, (b) partial refund. Both after Paymob keys exist and test mode is proven.
