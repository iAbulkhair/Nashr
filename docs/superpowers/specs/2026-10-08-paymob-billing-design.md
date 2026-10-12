# Paymob KSA billing (design, 2026-10-08)

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** merged as #279 (2026-10-08, in `production`), off until the founder adds the Paymob variables (`docs/system/variables.md` section 4a); a live test payment: unverified.

Status: built on branch `claude/quizzical-galileo-5b3662`, **test mode only, off until the founder adds the variables**. Nothing merged, deployed or configured. Rules 700-729 in `docs/system/tests.md`.

## 1. Why and what

Billing today is manual: static `PAY_LINK_*` links (or WhatsApp) on the billing page, the founder activates the plan in the console (`POST /api/admin/plan`) and records the money (`POST /api/admin/payments/{email}`, `POST /api/admin/topups`). On 2026-10-08 the founder chose Paymob KSA (paymob.sa). This design adds online payment for the three self-serve plans and the three top-up packs, saved-card monthly renewals, refunds from the console and a "manage plan" section, without replacing anything that works today:

- Paymob is **off** unless `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET` and `PAYMOB_INTEGRATION_ID_CARD` are all set (`paymobConfig()` in `src/lib/paymob.ts`). Off means: both new public routes answer 404, the billing page shows the `PAY_LINK_*`/WhatsApp buttons exactly as before, the cron skips every Paymob step.
- **Test keys only** unless `PAYMOB_LIVE=1`: a key that starts with `sk_live_`/`pk_live_` without it turns the gate off (logged once, name only). A preview or a branch deploy can never take real money by accident.
- Agency stays manual (contract price, `deal`). The founder console keeps every manual path (plan, payments, top-ups, refunds of unused credits).

## 2. Paymob pieces used (docs read 2026-10-08, developers.paymob.com)

| Piece | Call | Notes |
|---|---|---|
| Create intention | `POST https://ksa.paymob.com/v1/intention/`, header `Authorization: Token <secret key>` | `amount` in halalas, `currency` `SAR`, `payment_methods: [integration id]`, `items` (amounts must sum to `amount`), `billing_data` (`first_name`, `last_name`, `email`, `phone_number` required), `special_reference` (comes back as `order.merchant_order_id`), `notification_url` (card integrations: receives the transaction callback and the card token), `redirection_url`, `expiration` (seconds). Answer 201: `id` (`pi_test_…`), `client_secret`, `intention_order_id`, `payment_keys[{key, integration, order_id}]`. |
| Unified checkout | redirect to `https://ksa.checkout.paymob.com/?publicKey=<pk>&clientSecret=<client_secret>` | The public key is public; the client secret is single-use for that intention. No secret of ours is ever in a URL. |
| Transaction processed callback | `POST notification_url?hmac=<hex>`, body `{type:"TRANSACTION", obj:{…}}` | Sent on success and on decline. HMAC-SHA512 (lowercase hex) of the values of 20 fields in this order, no separator: `amount_cents, created_at, currency, error_occured, has_parent_transaction, id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded, is_standalone_payment, is_voided, order.id, owner, pending, source_data.pan, source_data.sub_type, source_data.type, success`. Booleans as `true`/`false`. |
| Card token callback | `POST notification_url?hmac=<hex>`, body `{type:"TOKEN", obj:{id, token, masked_pan, merchant_id, card_subtype, created_at, email, order_id, …}}` | HMAC over `card_subtype, created_at, email, id, masked_pan, merchant_id, order_id, token`. Sent when the customer ticks "save card" in checkout. |
| MIT (saved card, no customer) | 1) intention with `payment_methods: [Moto integration id]`; 2) `POST https://ksa.paymob.com/api/acceptance/payments/pay` `{source:{identifier:<card token>, subtype:"TOKEN"}, payment_token: payment_keys[0].key}` | Answers the transaction; the processed callback follows for the same transaction. |
| Refund | `POST https://ksa.paymob.com/api/acceptance/void_refund/refund` `{transaction_id, amount_cents}`, `Authorization: Token <secret key>` | 400 when the amount exceeds what is refundable (Paymob's own guard against a double refund). The parent's callback comes again with `is_refunded: true`. |
| Void | `POST …/api/acceptance/void_refund/void` `{transaction_id}` | Same-day reversal. In the adapter, not used by the console in v1. |
| Subscriptions | `POST …/api/acceptance/subscription_plans` (frequency in **days**), intention with the plan id, callbacks HMAC'd as `"{trigger_type}for{subscription_data.id}"` | **Not built** (fallback, section 6). |

Plain `fetch` with a 15 s timeout and `node:crypto`. No SDK (the npm Paymob packages are stale), no new dependency. The hosts are constants, never user input, so `safeFetch` does not apply; nothing user-supplied is ever fetched.

## 3. Money

- The price is always computed on the server from `src/lib/pricing.ts`: plans `PLAN_PRICE_SAR` (299 / 499 / 999 SAR ex-VAT), the first-month offer `firstMonthPriceSar` when `openOffer(u)` holds (no plan payment yet), packs `topupPriceSar`. The browser sends only `{kind, plan}` or `{kind, credits}`; an `amount` in the body is never read.
- VAT: `VAT_RATE` (15%) is added on top, in halalas: `vat = round(base × 0.15)`, `amount = base + vat`. 299 SAR → 343.85 SAR (34385 halalas); the 15% offer month 254 SAR → 292.10 SAR. The recorded payment (`payments:{email}`, the partners' commission base) is the amount **before** VAT, as the console records it today. Open question 5: if Thakeen is not VAT-registered yet, `PAYMOB_CHARGES_VAT` in `src/lib/billing.ts` is set to false and the customer pays the base only.
- Every callback is checked against the stored intent **and** against the pricing table again: `amount_cents`, `currency` (`SAR`), the Paymob order id and our reference must all match. A mismatch activates nothing, is written to `admin:log` (`paymob_mismatch`) and answered 200 (so Paymob does not retry forever); the founder refunds it from the console.

## 4. Flows

### 4.1 First payment (plan or pack)

1. The owner (`can(u, "billing.pay")`: owner only, refused while a founder impersonates) clicks a plan or a pack on `/{lang}/app/billing`. `POST /api/billing/checkout {kind:"plan", plan}` or `{kind:"topup", credits}`. Rate limit 10 an hour per account. A pack needs a paid plan (`topupsSold`), like the console. Paymob requires `billing_data.phone_number`: an account without a phone gets 409 `need_phone` and the page links to the profile.
2. The server mints our reference `pmi_` + 24 hex (random), stores the intent `paymob:intent:{ref}` = `{ref, email, kind, plan|credits, baseHalalas, vatHalalas, amountCents, currency:"SAR", offer, createdAt, by}` **before** calling Paymob, creates the intention (card integration, `special_reference: ref`, one item, `billing_data` from the account, `notification_url` = `{APP_ORIGIN}/api/billing/paymob/webhook`, `redirection_url` = `{APP_ORIGIN}/{lang}/app/billing?paymob=return`, `expiration` 3600), then saves Paymob's order id on the intent and the pointer `paymob:order:{orderId}` → ref. Answers `{ok, url}` (the unified checkout URL); the page redirects.
3. The customer pays on Paymob's page (and may tick "save card"). Paymob redirects back to the billing page: the page **never** reads the redirect's query for state (it is unsigned); it shows "Paymob is confirming your payment" and the account's real state.
4. Paymob posts the transaction callback to the webhook (4.4). On success the plan is activated (or the pack added) and the payment recorded; the card token callback, when the card was saved, stores the card for renewals.

Plan activation (`applyPaid` in `src/lib/billing.ts`, under `withUserLock(email)`): `plan` set; `setMonthly(u, allowanceOf(u))` and `renewedAt = monthKey()` when the plan changes or the account was locked (as the console's plan change; top-up packs kept); `billing` = `{provider:"paymob", plan, status:"active", paidThrough, autoRenew, failures:0, txns:[…last 12]}` with `paidThrough` one calendar month after today in Riyadh (`addMonths`, end of month clamped: Jan 31 → Feb 28/29). Then `enforceSeats` (as the console does after a plan change), then `recordPayment(email, {id: "pay_" + sha256("paymob:" + txnId)[0..24], amountSar: base, plan, date: today in Riyadh, reference: "paymob:<txnId>"}, "paymob")`: the existing path, so the first-month offer, the partner's commission and the referral reward all work unchanged, and a retry records nothing twice. A pack goes through `addPaidTopup` with the same deterministic payment id.

Upgrade or downgrade through checkout: the customer pays the new plan's full price and the period restarts today. No proration in v1. The same plan paid again before its month ends (an early "pay now") adds one month to `paidThrough` on the same anchor day instead of restarting it (rule 721). The founder setting a plan by hand (`POST /api/admin/plan`) deletes `User.billing`: the account is hand-managed from then on, so it is never charged or locked by the cron (rule 717).

### 4.2 Renewals (saved card, MIT, calendar months)

- The billing period is a calendar month from the payment day (anniversary), in Riyadh days. Credits still renew on the 1st of each UTC month for every paid plan (`renewIfDue`, unchanged): the two clocks stay independent, exactly as with manual billing today.
- The daily cron (`dailyFor`, default brand entry only, **before** `renewIfDue`, so an account locked that day gets no new month of credits) calls `renewPaymob(email)` when Paymob is on and `billing.paidThrough <= today` for an `active` or `past_due` account. One attempt per account per Riyadh day (`paymob:attempt:{email}:{day}`, `setNx`).
  - Auto-renew on, a saved card and the Moto integration set: an intention on the Moto integration (`special_reference` a new `pmi_` intent of kind `renewal`, the plan's full price from `pricing.ts`), then `payments/pay` with the card token. A success applies the payment at once (`applyPaid`, kind `renewal`: `paidThrough` moves one month from the **previous** `paidThrough` on the stored `anchor` day, so the anniversary never drifts; no plan or credit change), and the callback for the same transaction is then a no-op. While the charge is pending (`billing.pending {ref, day}`) no new charge is sent for two days: the callback decides.
  - Declined, or no card, or auto-renew off, or no Moto integration: `status: "past_due"`, `failures + 1`, `graceUntil = paidThrough + 7 days`; the owner sees it on the billing page ("Renew now" goes through checkout, 4.1, which can also save a new card). Retried the next day while in grace.
  - Past `graceUntil` with no payment: `status: "locked"`. A locked account is refused exactly like an ended trial: `trialOver(u)` answers true for it (`src/lib/auth.ts`), so chat, MCP, generation, media, onboarding, routines and the weekly plan all refuse with the existing "subscribe" messages. The monthly credit renewal skips a locked account (`renewalDue`). A successful checkout for any plan unlocks it with the month's credits.
- Paymob Subscriptions are **not** used while MIT works: their periods are day-based (30 days drifts from calendar months) and the module must be enabled per merchant. If MIT on mada is not available in KSA (open question 1), section 6 is the fallback.

### 4.3 Manage plan (our page, no Paymob portal)

The billing page's "Your subscription" card (Paymob on, an account billed by Paymob): plan, status (active / payment due / locked), paid through, the saved card (brand and last 4 only), and actions through `POST /api/billing/renewal {action}`:
- `cancel`: auto-renew off. The plan runs to `paidThrough`, then follows 4.2 (no charge attempt, grace, lock).
- `resume`: auto-renew on (needs a saved card, else 409 `no_card`).
- `remove_card`: deletes `paymob:card:{email}` and turns auto-renew off.
Owner only (`billing.pay`), rate-limited 30 an hour. A member sees the state without the buttons.

### 4.4 Webhook (`POST /api/billing/paymob/webhook`)

Public, no cookie. In order: 404 when Paymob is off; per-IP rate limit (240 a minute, before the body is read); body at most 64 KB (413); JSON (400); `hmac` from the query, checked with the transaction or the card-token field list by `body.type`, compared in constant time (`sameSecret`); 401 on a mismatch, a missing or a wrong-length value. Only then is anything used.

`TRANSACTION`:
1. Ignored with 200: a child transaction (`has_parent_transaction`: refunds, voids, captures), a refunded or voided parent, a pending one, a reference that is not `pmi_` + 24 hex, an unknown reference. The tenant is never taken from the payload: the email comes from **our** intent record, found by our random reference.
2. Exactly once: `paymob:done:{txnId}` set → 200 `already`. Otherwise a 60 s lock `paymob:txlock:{txnId}` (`db.lock`); held → 503 so Paymob retries later. Inside, the user record's `billing.txns` and the deterministic payment id make every step idempotent; the done marker is written only after everything succeeded, so a failure halfway is completed by Paymob's retry (500 until then).
3. Cross-checks (section 3): Paymob order id = intent's, `amount_cents` = intent's = the price recomputed from `pricing.ts`, `currency` = `SAR`, the transaction's live flag = our key's mode. Mismatch → `paymob_mismatch` in `admin:log`, done marker, 200.
4. `success: false` → the intent is marked failed. 200.
5. `success: true` → `applyPaid` (4.1 / 4.2), `paymob:txn:{txnId}` = `{ref, email, kind, amountCents, paymentId}` (for refunds), the invoice hook (section 7), `admin:log` (`paymob_paid`), done marker. 200.

`TOKEN`: matched to our intent through `paymob:order:{order_id}` (our pointer); the callback's `email` must equal the intent's account email. Stored as `paymob:card:{email}` = `{token, last4, brand, expMonth, expYear, savedAt, orderId}`. The token is never sent to any page, API answer or log; the account record keeps only brand and last 4. A plan intent's card turns auto-renew on.

### 4.5 Refunds (founder console)

`POST /api/admin/payments/{email} {action:"refund", id, reason?}` (founder only, `adminActor`): only a payment whose reference is `paymob:<txnId>` and whose `paymob:txn:{txnId}` record names the same account. Full refunds only in v1: Paymob refund for the transaction's `amountCents` (VAT included), then the payment is voided through the existing path (`voidPayment`, so the partner's commission goes too; a pack's payment goes with its pack through `voidPaidTopup`). `paymob:refunded:{txnId}` makes a retry finish the void without a second Paymob call; Paymob also refuses to refund more than was paid. The plan is not changed by a refund: the founder uses the plan control as today. Logged as `paymob_refund`. Errors: 404 `not_found`, 409 `not_paymob`, 502 `paymob_refund_failed`.

## 5. Data (Redis, all through `src/lib/db.ts`)

| Key | Value | TTL |
|---|---|---|
| `paymob:intent:{ref}` | the intent (4.1) | 400 days |
| `paymob:order:{paymobOrderId}` | our ref | 400 days |
| `paymob:txn:{txnId}` | `{ref, email, kind, amountCents, paymentId}` | 400 days |
| `paymob:done:{txnId}` / `paymob:txlock:{txnId}` | markers | 400 days / 60 s |
| `paymob:refunded:{txnId}` / `paymob:refundlock:{txnId}` | marker / lock | 400 days / 60 s |
| `paymob:attempt:{email}:{day}` | renewal attempt marker | 3 days |
| `paymob:card:{email}` | the saved card (token) | none; deleted with the account (`wipeAccount`) and by "remove card" |
| `user:{email}.billing` | `{provider, plan, status, paidThrough, anchor, autoRenew, failures, graceUntil?, card?: {brand, last4}, pending?: {ref, day}, txns}` | with the account |

No key is built from anything in a request: the email comes from the session (checkout, renewal actions) or from our own intent record (webhook); the reference and the Paymob ids are validated (`^pmi_[a-f0-9]{24}$`, positive integers) before use.

## 6. Fallback: Paymob Subscriptions (not built)

If MIT through a Moto integration is not enabled, or mada cards cannot be charged MIT in KSA: one Paymob subscription plan per self-serve plan (frequency 30 days, the plan's VAT-inclusive amount), the first payment through the same intention with the subscription plan id, and a third callback type (`subscription_data`, `trigger_type`) verified with `HMAC-SHA512("{trigger_type}for{subscription_data.id}")` from the body's `hmac`. "Successful Transaction" maps to `applyPaid` kind `renewal`; "Failed Transaction"/"Failed Overdue Transaction" to the grace path; "canceled"/"suspended" to auto-renew off. The cost is a 30-day period instead of calendar months and a plan per price (the offer month needs its own plan). Built only if Paymob confirms MIT is not available.

## 7. ZATCA seam

`src/lib/invoice.ts` `invoiceForPayment(event)` is called once per Paymob payment applied (plan, renewal, pack), with the account email, the payment id, the base, the VAT, the total and the Paymob transaction id. Today it does nothing and returns null. Phase 2 (e-invoicing, Fatoora) plugs a provider in there; the call site, its once-per-payment rule and its inputs do not change.

## 8. Variables (names only; values are added by the founder in the host, never in chat)

| Name | Required | What |
|---|---|---|
| `PAYMOB_SECRET_KEY` | yes | Server API key (`sk_test_…` in test). `Authorization: Token …` on intention, refund, void. |
| `PAYMOB_PUBLIC_KEY` | yes | Checkout public key (`pk_test_…`), in the checkout URL. |
| `PAYMOB_HMAC_SECRET` | yes | Verifies every callback. |
| `PAYMOB_INTEGRATION_ID_CARD` | yes | Card integration (3DS, tokenization enabled) for checkout. |
| `PAYMOB_INTEGRATION_ID_MOTO` | no | Moto integration for saved-card renewals. Without it renewals are by hand through checkout. |
| `PAYMOB_LIVE` | no | `1` allows live keys. Unset: only `sk_test_`/`pk_test_` keys turn the gate on. |

In the Paymob dashboard the card integration's processed callback can stay empty: the intention's `notification_url` carries ours.

## 9. Open questions for Paymob and the founder

1. Is MIT (Moto integration, `payments/pay` with a card token) enabled on the KSA account, and does it work on **mada** cards? Is the Subscriptions module enabled (fallback only)?
2. Is card tokenization enabled on the card integration, and does unified checkout show "save card" by default or does the intention need a flag?
3. How are null fields (Apple Pay, STC Pay) written into the HMAC string? v1 accepts cards only; null is written as an empty string, and a mismatch is a 401 we will see in the logs.
4. Does Paymob retry the processed callback after a non-2xx answer, how often and for how long?
5. VAT: is Thakeen VAT-registered? If not, `PAYMOB_CHARGES_VAT = false` until it is.
6. Refunds: window, partial refunds, and is a same-day void preferred over a refund?
7. Callback source IPs, if Paymob publishes them (an allow-list on top of the HMAC is optional).
8. Apple Pay and STC Pay: later, each its own integration id.

## 10. Test plan (rules 700-722 written, 723-729 reserved; `tests/paymob.test.ts`)

HMAC (documented sample string, good, tampered, reordered keys, wrong order, missing, wrong length), card-token HMAC string, gate off (404, page falls back), test-key guard, checkout (owner only, member 403, founder impersonation 403, server-side amount with VAT and offer, pack needs a paid plan, phone required, intent stored before Paymob), webhook (bad HMAC 401, unknown ref ignored, activation, duplicate callback is a no-op, concurrent lock, amount mismatch not activated, decline, pack credited), card token stored and never exposed, renewal success (anniversary kept, payment recorded), decline then grace then lock (`trialOver` true, spending refused), unlock by checkout, manage actions, refund (Paymob called once, payment voided, retry safe, other account's payment refused), wipe deletes the card.
