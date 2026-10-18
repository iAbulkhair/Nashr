# Geidea replaces Paymob for card payments (design, 2026-10-18)

Status: **spec only**. No code, variable, route or stored record has changed. Card payments stay **off** until the founder says to switch them on, and going live (real money) is a separate founder decision after that. Branch `claude/geidea-swap-spec`, no pull request. Rules **2230-2259** are reserved for the build (section 9). Flows section: the next free number when the build lands (87 is the last on `main` at `6b8090a6`).

Decision: on 2026-10-18 (quiz answers) the founder chose Geidea (https://geidea.net/ksa/ar) instead of Paymob KSA for card payments. The company papers (commercial registration, VAT number, IBAN) were started the same day, and an accountant and a lawyer have been contacted. The founder checklist job `paymob` is retitled Geidea.

Sources:
- **Geidea side.** Geidea's official developer documentation (docs.geidea.net, page index at https://docs.geidea.net/llms.txt) and Geidea's own GitHub organisation (github.com/GeideaSolutions), read on 2026-10-18. The docs pages carry update dates from 2025-06 to 2025-10. Every Geidea claim below names its page. The four signature formulas (session, callback, refund, saved-card charge) were read twice, once by a research pass and once directly. Anything the official pages do not say is marked **UNVERIFIED** and is a question in section 10. No third-party source is used.
- **Paymob side.** The code on `main` at `6b8090a6`:
  - #279: Paymob KSA billing, rules 700-722, spec `2026-10-08-paymob-billing-design.md`.
  - #342: the money fixes, rules 1300-1308 (a console refund ends the plan; a dashboard refund changes nothing).
  - The founding offer and price lock: rules 1700-1712, `src/lib/founding.ts`.
  - #378: the provider seam, rules 2050-2063.
  - The six `PAYMOB_*` variables (`docs/system/variables.md` section 4a).

## 1. What changes and what does not

The 2026-10-17 seam (rule 2050) was built for this swap. Billing (`src/lib/billing.ts`) reaches a card processor only through `PaymentProvider` (`src/lib/payments/provider.ts`), and `paymentProvider()` (`src/lib/payments/index.ts`) is the one place the processor is chosen. Most of the swap is a second implementation, `src/lib/geidea.ts`. The rest is the five places where Paymob's shapes leaked into the seam and the stored records:

1. Numeric transaction ids.
2. Amounts in halalas.
3. The signature in the query string.
4. A separate card-token callback.
5. The literal `provider: "paymob"`.

These stay exactly as they are:

- **Prices come from code.** `priceFor` computes every amount from `src/lib/pricing.ts`:
  - 299 / 499 / 999 SAR before VAT, and the 15% first-month offer.
  - The top-up packs.
  - The founding price lock (rule 1706).

  The browser sends only `{kind, plan}` or `{kind, credits}`.
- **The account comes from our own intent record**, found by our random reference. It is never read from a callback.
- **A callback is checked against our price.** A callback whose amount, currency, order or live flag disagrees with the intent and with `priceFor` applies nothing (rule 2051).
- **Each order is applied once.** That holds through a done marker, a short lock and idempotent steps inside (rule 2052).
- **A console refund ends the plan** (rule 1300), and with it the founding seat and price lock (rule 1708). A refund made in the processor's own portal changes nothing on the account (rule 1301).
- **A failed renewal follows the same path.** It moves to `past_due`, gets 7 days of grace (`GRACE_DAYS`), then `locked`. `trialOver` is true for a locked account.
- **Deleting an account stops renewals first** (rules 1955, 1956). The saved card goes under the account lock, and the renewal re-checks under the same lock before it charges.
- **Payment records are unchanged.** `recordPayment` / `addPaidTopup` keep the partner commission, the first-month offer and the referral reward working, and `invoiceForPayment` (the ZATCA seam, still empty) is called once per payment.
- **Every manual path stays:** `PAY_LINK_*`, WhatsApp, the console's plan, payment and top-up controls, and the hand-set paid-through day (rule 1302).
- **Off by default.** With no `GEIDEA_*` variable set, everything answers exactly as on `main` today:
  - The checkout, renewal and webhook routes answer 404.
  - The billing page shows the pay links.
  - The daily cron skips renewals.

## 2. Geidea pieces used (official docs, read 2026-10-18)

Hosts are constants in code, never user input; Geidea is called with plain `fetch`, the same pattern as `src/lib/paymob.ts` (15 s timeout, `redirect: "error"`, `cache: "no-store"`). `safeFetch` does not apply because nothing user-supplied is fetched. There is no official Node.js server SDK: GeideaSolutions on GitHub publishes Android, iOS, Flutter and React Native SDKs and e-commerce plugins only. So no new dependency is added.

| # | Piece | What the docs say | Source |
|---|---|---|---|
| G1 | KSA host | API `https://api.ksamerchant.geidea.net`; hosted page `https://www.ksamerchant.geidea.net/hpp/checkout/?{sessionId}`; script `https://www.ksamerchant.geidea.net/hpp/geideaCheckout.min.js`. The reference lists the KSA server as "Saudi Arabia - Production". | https://docs.geidea.net/docs/geidea-checkout-v2, https://docs.geidea.net/reference/create-session-v2-1, https://docs.geidea.net/reference/refund-1-1 |
| G2 | Test mode | No separate KSA test host is published. The FAQ mentions a sandbox "with a simulator" but gives no URL. Test credentials come from the Geidea contact, and order payloads carry `isTest`. Test cards are published per brand, with the expiry date choosing the outcome: 01/39 succeeds, 05/39 is declined, 04/27 is expired, 08/28 times out. mada challenge 5588480000000003, mada frictionless 4464040000000007, plus Visa and Mastercard. **UNVERIFIED: the test host, and whether test credentials can be told apart from live ones.** | https://docs.geidea.net/docs/test-cards, https://docs.geidea.net/docs/troubleshooting-faqs, https://docs.geidea.net/docs/card-type-transactions |
| G3 | Authentication | HTTP Basic on every call: username = merchant **Public Key**, password = **API Password**. Both come from the merchant portal (Payment Gateway → Gateway Settings) or the enablement email. The API password is also the HMAC key of every signature. Create Session must be server-to-server. | https://docs.geidea.net/docs/pre-requisites, https://docs.geidea.net/docs/geidea-checkout-v2 |
| G4 | Create session (hosted page) | `POST /payment-intent/api/v2/direct/session`. `amount` is a **decimal in riyals with 2 decimals** (not halalas). Other fields: `currency`, `timestamp`, `signature`, `callbackUrl` (https only), `merchantReferenceId`, `language` (`ar`/`en`), `returnUrl`, `paymentOperation` (`Pay`), `cardOnFile`, `cofAgreement{id,type}`, `initiatedBy`, `customer{…}` (email and phone required only for Tabby/Tamara), `hideWallets`, `appearance.uiMode`. The answer carries `session.id`, `responseCode`/`detailedResponseCode` (`000`/`000` = success). A session expires after 15 minutes by default. **UNVERIFIED: the reference says `merchantReferenceId` "must be a valid UUID" while the samples send any string; this design sends a UUID either way.** | https://docs.geidea.net/reference/create-session-v2-1, https://docs.geidea.net/docs/geidea-checkout-v2 |
| G5 | Session signature | Concatenate `MerchantPublicKey + amount (2 decimals) + currency + merchantReferenceId + timestamp`. HMAC-SHA256 keyed with the API password, then Base64 of the raw bytes (the PHP sample: `base64_encode(hash_hmac('sha256', $data, $apiPassword, true))`). **UNVERIFIED: the timestamp format.** Samples show `Y/m/d H:i:s` and `3/18/2024 5:16:48 AM`. We sign exactly the string we send. | https://docs.geidea.net/docs/geidea-checkout-v2 ("Signature") |
| G6 | Callback | A server-to-server JSON POST to `callbackUrl`: `{order:{…}, signature, timeStamp}`. `order` carries `orderId` (a UUID), `amount`, `currency`, `merchantReferenceId`, `status` (Success / Failed / InProgress), `detailedStatus` (Paid / PartiallyRefunded / OrderFailed …), `cardOnFile`, `tokenId`, `agreementId`, `agreementType`, `paymentMethod{brand, maskedCardNumber, expiryDate}`, `isTest`, `totalRefundedAmount`, and `transactions[]` with `codes{responseCode, detailedResponseCode}`. Fulfil only on `responseCode` 000, `detailedResponseCode` 000, "Success", and a matching amount. | https://docs.geidea.net/docs/sample-callback-responses, https://docs.geidea.net/docs/card-type-transactions |
| G7 | Callback signature | "Concatenate the string of { MerchantPublicKey, OrderAmount, OrderCurrency, Orderid, Status, MerchantRefrenceId, timeStamp }", hashed with the API password (HMAC-SHA256), then Base64. The docs page does not say how to format the amount. Geidea's own WooCommerce plugin formats it with 2 decimals (`number_format($order['amount'], 2, '.', '')` in `ReturnHandler.php`). | https://docs.geidea.net/docs/sample-callback-responses, github.com/GeideaSolutions/WooCommerce-Geidea-Payment |
| G8 | When callbacks come | No callback while an order is InProgress, and none for a 3-D Secure failure alone. Closing the page sends "Transaction Cancelled By User". After payment, one callback carries the order's whole history, so several attempts arrive under the same `orderId`. **UNVERIFIED: retry policy after a non-2xx answer, timeout, expected answer, source IPs.** None of these is published. | https://docs.geidea.net/docs/sample-callback-responses |
| G9 | Saved card | A session with `cardOnFile: true` returns `order.tokenId` in the callback when the order is Paid. Detailed code 000.004 means "successful - but token was not created". There is also `GET /pgw/api/v1/direct/token/{tokenId}` and a delete-token call. **UNVERIFIED: the delete-token HTTP method.** | https://docs.geidea.net/docs/tokenization, https://docs.geidea.net/docs/api-response-codes-and-messages |
| G10 | Merchant-initiated charge (MIT) | Three steps. (1) The first session sends `initiatedBy:"Internet"`, `cardOnFile:true`, `cofAgreement:{id:<unique agreement id>, type:"Unscheduled"}`. (2) Each later charge creates a session with `initiatedBy:"Merchant"`, the same agreement id, `agreementType:"Unscheduled"`, `tokenId`. (3) Then `POST /pgw/api/v2/direct/pay/token`, signed over `MerchantPublicKey + SessionId + TimeStamp` (HMAC-SHA256, Base64). Code 750.005 = "AgreementID does not match initial value"; 750.006 = "initiatedBy not configured for this account" (MIT must be switched on by Geidea). **UNVERIFIED:** (a) whether the agreement fields go at the top level or inside `cofAgreement` (the guide and the reference disagree); (b) whether mada cards can be charged this way; (c) whether a fixed monthly charge we schedule ourselves should be `Recurring` rather than `Unscheduled` (the enum has both; the guides use only `Unscheduled`). | https://docs.geidea.net/docs/merchant-initiated-mit, https://docs.geidea.net/reference/merchant-initiated-transactions-1, https://docs.geidea.net/docs/api-response-codes-and-messages |
| G11 | Geidea subscriptions (fallback only) | `POST /subscriptions/api/v1/direct/subscription` with `cycleInterval` (day/week/month/year), `cycleFrequency`, `typeOfPayment:"RecurringPayment"`; the first charge goes through `/payment-intent/api/v2/direct/session-subscription`; a failed auto-debit is retried twice. Not used by this design (section 6.4). | https://docs.geidea.net/docs/subscriptions, https://docs.geidea.net/reference/create-session-subscription |
| G12 | Refund | `POST /pgw/api/v2/direct/refund`, required `orderId`, `refundAmount` (≥ 0.01, at most 2 decimals), `timestamp`, `signature`, `callbackUrl`. Signature: "Concatenate the string of {TimeStamp, MerchantPublicKey, RefundAmount, OrderID}", HMAC-SHA256 with the API password, Base64. "Full or Partial"; "You can refund multiple times for the same payment" up to the paid total (codes 800.007, 800.008). Only paid, captured or settled orders. 800.005 = refunds not enabled on the account. **UNVERIFIED: the refund window.** The page says only "must not have exceeded the allowed expiry days". | https://docs.geidea.net/reference/refund-1-1, https://docs.geidea.net/docs/refund-2, https://docs.geidea.net/docs/api-response-codes-and-messages |
| G13 | Void, capture, cancel | Void `POST /pgw/api/v3/direct/void` works on pre-authorised orders only. Capture and cancel exist. **Not used.** We take `Pay`, never a pre-authorisation. | https://docs.geidea.net/docs/void-1, https://docs.geidea.net/docs/cancel-order-1 |
| G14 | Fetch an order | `GET /pgw/api/v1/direct/order/{orderId}` returns the same `order` object as the callback. `GET /pgw/api/v1/direct/order?MerchantReferenceId={id}` looks one up by our reference. | https://docs.geidea.net/reference/get-order-by-id-1 |
| G15 | Wallets and 3-D Secure | Apple Pay on the hosted page needs Geidea's domain-association file at `/.well-known/apple-developer-merchantid-domain-association`, then Geidea switches it on. STC Pay is named in the FAQ and as a `paymentOptions` label, with no integration page. 3-D Secure 2 runs inside the hosted page. Taking card data through the direct API instead needs PCI DSS. | https://docs.geidea.net/docs/apple-pay, https://docs.geidea.net/docs/troubleshooting-faqs |

## 3. Mapping: Paymob today, Geidea tomorrow

| Area | Paymob (`main`) | Geidea | Change in our code |
|---|---|---|---|
| Gate | `paymobConfig()`: secret key, public key, HMAC secret, card integration id; live keys need `PAYMOB_LIVE=1` (rule 700) | `geideaConfig()`: `GEIDEA_PUBLIC_KEY` + `GEIDEA_API_PASSWORD` (G3) | New gate, same fail-closed rules. Geidea keys cannot be read as test or live (G2), so the live guard moves to the deploy (section 6.6). |
| Start a payment | `POST /v1/intention/` (Token auth), then the unified checkout `?publicKey&clientSecret` | Create session (G4, signed per G5, Basic auth), then redirect to `/hpp/checkout/?{sessionId}` | `createCheckout` returns `{orderId: null, url}`. Geidea creates its order id only when the customer pays, and the session id is not an order. |
| Our reference | `special_reference` = `pmi_` + 24 hex, echoed as `order.merchant_order_id`, **not** covered by the HMAC | `merchantReferenceId` = a random UUID v4, echoed in the callback, **covered by the signature** (G7) | New reference format, validated as a UUID. Because the reference is signed, a callback can no longer be moved onto another intent. |
| Amount | `amount_cents` (halalas, integer) | `amount` (riyals, 2 decimals) | Integer conversion both ways, no floating point in the comparison (rule 2236). |
| Transaction id | Positive integer (`obj.id`) | `orderId` UUID, one per order, holding every attempt (G8) | `PaymentTxn.id` becomes a string (rule 2230). Exactly-once is per Geidea order. |
| Callback signature | HMAC-SHA512 hex of 20 fields, `?hmac=` in the query | HMAC-SHA256 Base64 of 7 values (G7), `signature` in the body | `verifyWebhook` gets the signature from the event (rule 2232), compares with `sameSecret`. |
| Saved card arrives | A separate `TOKEN` callback, matched by order pointer and email | `tokenId` + `agreementId` inside the paid order callback (G9) | The card rides on the transaction (rule 2233). No email match is needed: the signed reference already names our intent. |
| Renewal (MIT) | A Moto-integration intention, then `payments/pay` with the token | A Merchant session, then `pay/token` (G10) | `savedCard.charge` takes the card's token **and** agreement id (rule 2234). The switch that offers it is `GEIDEA_MIT=1`, the counterpart of `PAYMOB_INTEGRATION_ID_MOTO`. |
| Refund | `void_refund/refund {transaction_id, amount_cents}`, full only from the console | `refund {orderId, refundAmount}` (G12): full or partial, several times | Full refund at parity (rule 2254). Partial refund only on the founder's decision (rule 2255). |
| Dashboard refund | Arrives as a child or refunded transaction; ignored (rule 1301) | Arrives as a callback for the **same** order with `PartiallyRefunded` / refunded totals | The order's done marker already answers it. Any order with a refunded total is ignored and logged for the founder (rule 2256). |
| Missing callback | Paymob retries (assumed in the Paymob spec, never verified) | No retry policy published, and no callback while InProgress (G8) | New reconciliation by fetching the order (G14, rule 2248). |
| Phone | Required (`need_phone`) | Not required for cards (G4) | `need_phone` only for Paymob (rule 2249). |
| Webhook route | `POST /api/billing/paymob/webhook` | `POST /api/billing/geidea/webhook` | New route, CSRF exemption `/api/billing/geidea/`, the same order of checks (rule 2245). |
| Founding offer | `claimOnPayment` / `newLock` write `by: "paymob"` | Same calls | `by` = the provider's name. Nothing else in `src/lib/founding.ts` changes. |
| Price lock renewal | `priceFor("renewal", …, lockedBaseHalalas)` | Same | None. The renewal session carries the locked price. |
| ZATCA seam | `invoiceForPayment({provider:"paymob", providerRef: txnId})` | `provider:"geidea"`, `providerRef: orderId` | The type union only. |
| Console audit | actor `paymob`; `paymob_paid`, `paymob_mismatch`, `paymob_unapplied`, `paymob_locked`, `paymob_refund` | actor `geidea`; `geidea_paid` … | `{provider}_` prefix. No console reader parses these names (checked 2026-10-18: no component under `src/components/admin` reads them). |
| Integrations page | Row `paymob`: names `PAYMOB_*`, the `paymob_live` check | Row `geidea`: names `GEIDEA_*` | New row (rule 2257). The Paymob row stays until the contract release. |
| Customer copy | Privacy text, help "processors" answer (`src/lib/help.ts`), legal drafts name Paymob | Geidea | Step 6 (rule 2258), with the lawyer's review of the legal drafts. |

## 4. The seam's types (code only, no stored shape)

`src/lib/payments/provider.ts` changes. Each change keeps Paymob's behaviour byte for byte, and every existing Paymob test stays green:

1. **Ids are strings.** `PaymentTxn.id: string`, `orderId: string | null`. The Paymob adapter writes `String(n)`. `paymentIdFor(provider, id)` hashes `"{provider}:{id}"`. For Paymob that is the same `"paymob:{n}"` text as today, so every Paymob payment id stays the same (a golden test pins three known ids).
2. **The provider name is a union.** `name: "paymob" | "geidea"`, and `PaymentError.provider` follows it.
3. **The signature comes with the envelope.** `parseEvent(body, query)` returns `{kind, obj, signature}`. Paymob reads `query.get("hmac")`; Geidea reads `body.signature` and `body.timeStamp`. `verifyWebhook(e)` takes no second argument.
4. **The card rides on the transaction.** `PaymentTxn.card?: { token, agreementId: string | null, last4, brand, expMonth, expYear }`. Geidea fills it from the paid order. Paymob keeps its separate `card_token` event (its `kind` stays in the union until the contract release).
5. **The saved-card charge carries the agreement.** `savedCard.prepare(i, card)` returns `{ref: string, key: string | null}`; for Geidea, `key` is the session id. `savedCard.charge(prepared, card)` takes `{token, agreementId}`. Paymob ignores `agreementId`.
6. **Order lookup is optional.** `fetchByReference?(ref): Promise<PaymentTxn | null>` (Geidea G14; Paymob leaves it undefined).
7. **Refunds take any amount up to the paid total.** `refund(id, amountHalalas)` is unchanged in shape. The Geidea adapter accepts any amount from 1 halala to the paid total; billing decides which amount to send (section 6.5).

## 5. Stored data and the two releases (rule 679)

Paymob was never switched on: no `PAYMOB_*` value is set on production or staging (variables.md section 4a; the founder confirms in section 10, question F7). So no `paymob:*` record should exist anywhere. The rule still applies, because stored shapes change. It costs little here.

**New keys (expand release).** All are built in `src/lib/keys.ts` (the registry, rules 2030-2039). None is built from request data. Each is built from a UUID we generated and validated, from a Geidea order id validated as a UUID **after** the signature matched, or from the session's email.

| Key | Value | TTL |
|---|---|---|
| `pay:intent:{ref}` | The intent, as `PayIntent` today, plus `provider`, `agreementId?`, `sessionId?`, `orderId?: string` | 400 days |
| `pay:open` | Sorted set: open refs by creation time, for reconciliation (6.3) | Members removed when settled or after 48 h |
| `pay:txn:{provider}:{orderId}` | `{ref, email, kind, amountHalalas, paymentId, refundedHalalas?}` | 400 days |
| `pay:done:{provider}:{orderId}` / `pay:txlock:{provider}:{orderId}` | Markers | 400 days / 60 s |
| `pay:refunded:{provider}:{orderId}` / `pay:refundlock:{provider}:{orderId}` | Marker (full refund) / lock | 400 days / 60 s |
| `pay:attempt:{email}:{day}` | Renewal attempt marker | 3 days |
| `pay:card:{email}` | `{provider, token, agreementId, last4, brand, expMonth, expYear, savedAt, orderId}` | None; deleted with the account and by "remove card" |
| `pay:last:{email}` | The latest checkout ref (rule 1155) | 1 day |

**Changes to existing shapes:**
- `User.billing.provider` becomes `"paymob" | "geidea"`. `billingLocked` and the renewal-due check (today `paymobRenewalDue`, renamed `renewalDue`) accept both.
- `Payment.reference` becomes `geidea:{orderId}` alongside `paymob:{n}`. The refund route's parser accepts both forms.
- `User.founding.by` and `User.priceLock.by` take the provider name.

**Release 1 (expand).** Steps 1 to 6 of section 9 ship with payments still off.
- New code reads both the Paymob keys and shapes and the new ones. It writes the new ones only when Geidea is the chosen provider.
- `wipeAccount` deletes `paymob:card:{email}`, `paymob:last:{email}`, `pay:card:{email}` and `pay:last:{email}`.
- If production rolls back to old code after Geidea took a payment, old code sees `provider: "geidea"`:
  - `billingLocked` is false and `paymobRenewalDue` is false.
  - So the account keeps its plan and is never charged or locked by old code. The founder manages it by hand.
  - Old code ignores the `pay:*` keys.

  That is safe in the rule 679 sense: nothing is lost and nothing is charged twice.

**Release 2 (contract, rule 2259).** This is a later release, and only after Geidea has taken live payments that the founder has checked. It removes:
- `src/lib/paymob.ts` and `/api/billing/paymob/webhook`.
- The CSRF entry `/api/billing/paymob/` and the `paymob` union members.
- The `card_token` event kind and the `PAYMOB_*` names (variables.md, `.env.example`, the Integrations row).
- The `?paymob=return` reader.

Before it, an idempotent read-only script counts `paymob:*` keys on production (expected 0). The founder runs it. It never runs at build time.

## 6. Flows that differ from Paymob

### 6.1 First payment (plan or pack)

1. The owner presses pay on `/{lang}/app/settings/billing`, which posts `POST /api/billing/checkout`. These are unchanged:
   - Owner only (`billing.pay`), refused while the founder impersonates.
   - Rate limit 10 an hour.
   - A pack needs a paid plan.
   - The founding flag (rule 1702) is decided by the server.
2. The server mints `ref = randomUUID()` and computes the price with `priceFor`. For a plan, it also mints `agreementId = randomUUID()`. It then stores `pay:intent:{ref}` and adds `ref` to `pay:open`, **before** calling Geidea.
3. Create session (G4):
   - `amount` = `toRiyals(amountHalalas)` and `currency: "SAR"`.
   - `merchantReferenceId: ref`.
   - `callbackUrl` = `{APP_ORIGIN}/api/billing/geidea/webhook`.
   - `returnUrl` = `{APP_ORIGIN}/{lang}/app/settings/billing?pay=return`.
   - `language: lang` and `paymentOperation: "Pay"`.
   - For a plan: `cardOnFile: true`, `initiatedBy: "Internet"` and `cofAgreement: {id: agreementId, type: "Unscheduled"}`.
   - `customer: {email, firstName, lastName}`, with no phone (question F4).
   - `hideWallets` set so v1 offers cards only (question F3).
   - `timestamp`, and the G5 signature.

   A `responseCode` other than `000` marks the intent failed and answers 502 `provider_error`.
4. The answer is `{ok, url}` with `url = https://www.ksamerchant.geidea.net/hpp/checkout/?{sessionId}`. The page navigates there. We use the redirect, not the script, so no third-party script runs on our pages and the content security policy does not change.
5. The customer pays on Geidea's page (3-D Secure inside it, G15). Geidea sends the customer back to `returnUrl`. The page never trusts that request's query. It shows the account's real state through `GET /api/billing/status` (rule 1155), which also reconciles (6.3).
6. Geidea posts the callback (6.2). On a paid order the plan is activated or the pack added, the payment recorded, and the card saved with its agreement id.

### 6.2 Webhook `POST /api/billing/geidea/webhook`

The order of checks is the same as Paymob's:
1. 404 unless Geidea is the chosen provider.
2. A per-IP rate limit (240 a minute), before the body is read.
3. Body at most 64 KB (413).
4. JSON (400).
5. The envelope `{order: object, signature: string, timeStamp: string}` (400).
6. The signature (G7): recomputed over `publicKey + toRiyals(parse(order.amount)) + order.currency + order.orderId + order.status + order.merchantReferenceId + timeStamp`, Base64. It is compared with `sameSecret` against a value that must be 44 Base64 characters. Anything else answers 401.

Nothing in the body is used before step 6. Then:

- **Ignored (200).** `merchantReferenceId` is not a UUID; no intent has that reference; or the order has a refunded total above 0 (`totalRefundedAmount`, `detailedStatus` PartiallyRefunded or Refunded). The last case is logged `geidea_external_refund` for the founder (rule 2256).
- **Exactly once.** If `pay:done:geidea:{orderId}` is set, answer 200 `already`. Otherwise take the lock and run the same `applyTransaction`. The done marker is written last, so a failure halfway answers 500 and the next delivery or the reconciliation (6.3) completes it.
- **Cross-checks (rule 2051).**
  - The amount in halalas equals the intent's and `priceFor`'s.
  - The currency is `SAR`.
  - `isTest` agrees with the deployment's mode (6.6).
  - For a renewal, the order's `agreementId` equals the saved card's.

  A mismatch applies nothing, writes `geidea_mismatch` to the console log, sets the done marker and answers 200.
- **Paid.** `status` Success, `detailedStatus` Paid, and the success codes `000` / `000` on the order's last `Pay` transaction (G6; **UNVERIFIED** whether the codes also sit on the order itself; the parser accepts either and requires both to agree when both are present). Then `applyPaid` runs as today. When `tokenId` is present and the intent is a plan, the card is saved under the account lock. Detailed code 000.004 (paid, no token) applies the payment, saves no card, and leaves automatic renewal off.
- **Declined.** `status` Failed, or "Transaction Cancelled By User". The intent is marked failed. 200.
- **InProgress.** Should never arrive (G8); if it does, it is ignored and the reconciliation settles it.

### 6.3 Reconciliation (new; Geidea publishes no retry policy)

A payment whose callback was lost must still be applied, so there are two ways to settle an open intent. Both read the order from Geidea with our Basic-auth call (G14). The answer of our own authenticated TLS call is trusted the way the Paymob code trusts its own `payments/pay` answer. It still goes through the same `applyTransaction`: the same price cross-checks, the same exactly-once markers.

1. **From the return page.** `GET /api/billing/status` finds the account's last checkout (`pay:last:{email}`). While it is open, older than 60 seconds and younger than 48 hours, the route asks Geidea `order?MerchantReferenceId={ref}`, at most once every 20 seconds per account (rate limit).
2. **From the daily cron.** Before renewals, the cron takes up to 50 refs from `pay:open` that are older than 20 minutes (the session's 15 plus margin) and younger than 48 hours. It fetches them with `pmap` (src/lib/parallel.ts, concurrency 5). Refs older than 48 hours are marked `expired` and leave the set.

### 6.4 Renewals (self-run MIT, calendar months)

The billing period, the anniversary day, the one attempt per Riyadh day, pending for two days, grace and lock are all unchanged (Paymob spec 4.2; `renewPaymob`, renamed `renewOnline`). `p.savedCard` is non-null only when `GEIDEA_MIT=1`, meaning Geidea has switched MIT on for the account (750.006 otherwise).

1. A renewal intent: a new UUID ref, `kind: "renewal"`, the price from `priceFor("renewal", …, lockedBaseHalalas)` (rule 1706), stored and added to `pay:open`.
2. Create a session: `initiatedBy: "Merchant"`, the saved card's `tokenId` and `agreementId`, `agreementType: "Unscheduled"`, the same amount, `merchantReferenceId: ref`, the callback URL (G10 step 2.1).
3. Rule 1956, unchanged. Under the account lock, the account still exists, renewal is still on and the card is still saved. Otherwise the renewal stops.
4. `POST /pgw/api/v2/direct/pay/token` with the session id, signed per G10. The answer goes through `applyTransaction` like Paymob's `payments/pay` answer; the callback for the same order then answers `already`.
5. A decline, 750.005 (agreement mismatch: the card is dropped and automatic renewal turned off) or any error leads to `past_due` and grace, exactly as today.

Fallback, not built: if Geidea says mada cannot be charged MIT, or that a fixed monthly charge must use its Subscriptions API (G11), a second design will map our plan prices onto Geidea subscriptions (`cycleInterval: "month"`, which keeps calendar months). It loses three things: the price lock's per-renewal figure, the first-month offer as its own amount (it would need its own subscription), and our own retry and grace timing (Geidea retries twice). Decision F1 in section 10.

### 6.5 Refunds (founder console)

- **Full refund at parity** (rule 2254). `POST /api/admin/payments/{email} {action:"refund", id, reason}` keeps the founder only, the second factor and the required reason. Then:
  1. It finds the payment and checks that `pay:txn:geidea:{orderId}` names the same account and payment id.
  2. It refunds `amountHalalas` once (G12), guarded by the refunded marker and the lock.
  3. It voids the payment (a pack's payment with its pack).
  4. For a plan or renewal payment, it ends the plan (rule 1300), and with it the seat and the lock (rule 1708).

  Errors: `not_online` replaces `not_paymob`, `refund_failed` replaces `paymob_refund_failed`. During expand both old and new codes are answered and read.
- **Partial refund** (rule 2255, built only if the founder says yes to F5). Geidea allows several partial refunds up to the paid total (G12). That makes the founding offer's 7-day refund (rule 1707: paid minus used credits, shown to the founder today as a figure only) payable for the first time. The proposal:
  - The console sends `amountHalalas`, between 1 and the paid total minus what was already refunded.
  - The refund is recorded on the payment as `Payment.refund = {amountHalalas, reason, by, at, partial}` (an optional field, expand).
  - `pay:txn` keeps `refundedHalalas`, so a retry never refunds twice. Geidea's own 800.007 and 800.008 are a second guard.
  - The plan ends, as the founding spec says for the 7-day refund.
  - The partner commission is voided in full (open question F5b: pro rata instead?).

### 6.6 Test mode and the live guard

Geidea keys do not show whether they are test or live (G2), and Geidea publishes one KSA host labelled production (G1). So the Paymob guard (refuse live-looking keys without `PAYMOB_LIVE=1`) cannot be copied. Instead:

- `GEIDEA_LIVE=1` declares that the keys are live. It is honoured only on a production deploy (`isProductionDeploy()`, src/lib/deploy-env.ts). Set anywhere else, the gate closes and logs `geidea_live_refused` once.
- Without `GEIDEA_LIVE`, the deployment is in test mode. Every order must carry `isTest: true`. One that does not is a mismatch: nothing is applied, and the founder is told so they can refund it.
- That still cannot stop a live key pasted into staging from charging a real card before the mismatch is seen. So the founder's rule is: **live credentials are entered only in the production hPanel, and only on the day he says go live.** Staging gets the test credentials only. Question G5 asks Geidea whether test and live credentials or hosts can be told apart, which would let code refuse the mix-up before any charge.

## 7. Variables (names only; the founder sets values in hPanel, never in chat)

These go in a new section 4b of `docs/system/variables.md` and in `.env.example` with empty values (rule 1977). They are read per call in `src/lib/geidea.ts` only.

| Name | Required | What | Without it | Secret |
|---|---|---|---|---|
| `GEIDEA_PUBLIC_KEY` | Yes | Merchant public key: the Basic-auth username and the first value of every signature (G3) | Geidea off | No, keep internal |
| `GEIDEA_API_PASSWORD` | Yes | Basic-auth password and the HMAC key of every signature, ours and Geidea's (G3, G5, G7) | Geidea off | **Yes** |
| `GEIDEA_MIT` | No | `1` once Geidea has switched merchant-initiated charges on for the account. Enables saved-card renewals | Renewals are not charged automatically: a due month becomes past due and the owner pays it from the billing page | No |
| `GEIDEA_LIVE` | No | `1` declares live credentials; honoured only on a production deploy (6.6) | Test mode: only orders with `isTest: true` are applied | No |

No other value is needed: the host is a constant (G1), and Geidea has no separate HMAC secret.

When both Paymob and Geidea are configured during the expand release, Geidea is chosen and one console line `payment_provider_both_set` is written. The Paymob webhook then answers 404.

## 8. Security checks that carry over (and the new ones)

- **The signature comes first.** Every callback is verified before any field is used. The comparison is constant-time `sameSecret`, never `===`. The signature and the API password are never logged, never put in a URL and never returned. A `PaymentError` carries `geidea_{code}[:{status}]` and at most Geidea's `detailedResponseCode`. Never the body.
- **The reference is signed.** `merchantReferenceId` is inside both signatures, so an attacker holding a genuine callback cannot point it at another intent. A replayed genuine callback is harmless: the done marker makes it `already`. A freshness check on `timeStamp` is not built, because the format is unverified (G5).
- **Keys never come from the request.** Every key is built from our own UUIDs, a signature-verified order id or the session's email. Every UUID is validated with one regular expression before use.
- **The card token stays in one place.** `tokenId` and `agreementId` live only in `pay:card:{email}`. No page, API answer, log or data download shows them. The account record keeps brand and last 4 only. "Remove card" and account deletion also call Geidea's delete-token. That call is best effort: it is logged on failure, and our own record is deleted regardless.
- **No card data touches our servers.** The hosted page takes it; we never see a card number (G15: the direct API would need PCI DSS, so it is out of scope).
- **The model is never the approver.** Prices, refunds and the plan are decided in code; Noor and the agents take no part. A checkout starts only from the owner's own click (`billing.pay`).
- **Rate limits.** Checkout 10 an hour; renewal settings 30 an hour; webhook 240 a minute per IP; the status route's reconciliation at most once every 20 seconds per account.

## 9. Build order and rule numbers

Rules 2230-2259 were checked free on 2026-10-18:
- `origin/main` `docs/system/tests/` ends at 2140-2149.
- Local branches use up to 2213 (2160-2179 and 2200-2207 integrations, 2192 lock, 2210-2213 Zid).
- 2150-2159 are held by help URLs and 2180-2199 by the Salla Easy Mode spec.
- The only open pull request, #387, uses 1980-1999.

The reservation is noted in the session notes folder. The build adds `docs/system/tests/2230-geidea-swap.md` (rule 788).

Each step is one commit on one branch, with its tests in `tests/geidea.test.ts` (and the existing `tests/paymob.test.ts`, `tests/payment-storage-seams.test.ts` and `tests/founding.test.ts` kept green). There is one draft pull request at the end (rule 772). Steps 1-6 are release 1 (expand), with payments off. Step 7 is release 2 (contract).

| Step | Rules | What | Needs before it |
|---|---|---|---|
| 0 | none | Founder and Geidea: the merchant account with Payment Gateway, test credentials, MIT and refunds switched on, and answers to section 10 | Commercial registration, IBAN |
| 1 Seam | 2230 | `PaymentTxn.id` / `orderId` are strings; `paymentIdFor("paymob", n)` gives every existing Paymob payment id unchanged (golden ids) | none |
| | 2231 | Provider name union; `Billing.provider` read as either; `billingLocked` and `renewalDue` accept both; a stored Paymob record reads unchanged | |
| | 2232 | `parseEvent(body, query)` carries the signature; Paymob still verifies `?hmac=` exactly as rules 2053-2054 pin | |
| | 2233 | A card may ride on a paid transaction; billing saves it under the account lock, matched to the intent's account only | |
| | 2234 | `savedCard.prepare/charge` carry `{token, agreementId}`; Paymob ignores the agreement and keeps rule 2055 | |
| 2 Adapter | 2235 | `geideaConfig()`: both names set or null; `GEIDEA_LIVE` honoured only on a production deploy; KSA host constant; the provider object carries no key; nothing secret in errors or logs | Step 1 |
| | 2236 | Riyals and halalas convert with integer math only: `34385` ↔ `"343.85"`; a callback amount with more than 2 decimals, negative, non-finite or non-numeric is refused | |
| | 2237 | Create session: the body (plan with `cardOnFile`, `cofAgreement` Unscheduled, `initiatedBy` Internet; pack without), Basic auth, the G5 signature against a fixed sample, the redirect URL built from the session id only | |
| | 2238 | Callback signature (G7): good, tampered field (each of the 7), reordered, wrong key, short, non-Base64, missing; never compared with `===` (source scan) | |
| | 2239 | Order parsing: paid only on Success + Paid + 000/000; cancelled by user and Failed are declined; InProgress pending; any refunded total is refunded; `isTest` sets the live flag | |
| | 2240 | Card from a paid order: `tokenId` and `agreementId` validated as UUIDs, brand, last 4 from the masked number, expiry; 000.004 gives no card | |
| | 2241 | MIT: a Merchant session with token and agreement, then `pay/token` signed over public key + session id + timestamp; 750.005 / 750.006 are declines with the code kept | |
| | 2242 | Refund: the G12 body and signature, any amount from 0.01 SAR to the paid total; 800.x answers give `PaymentError` `geidea_refund_failed:{status}` | |
| | 2243 | `fetchByReference` (G14), parsed by the same parser | |
| 3 Billing | 2244 | Provider choice: Geidea when its gate is open, else Paymob; both gives Geidea plus one log line; each webhook answers 404 unless its provider is chosen | Step 2 |
| | 2245 | `POST /api/billing/geidea/webhook`: the order of checks in 6.2, CSRF exemption `/api/billing/geidea/`, key-ratchet entry, permissions row, 500 on a failure halfway | |
| | 2246 | `pay:*` keys from `src/lib/keys.ts`; refs are UUID v4; the intent is stored before the session; old `pmi_` refs still read | |
| | 2247 | Exactly once per Geidea order: the paid callback twice, then the refund callback for the same order, gives one payment, one `txns` entry | |
| | 2248 | Reconciliation (6.3): the status route (open, 60 s to 48 h, once per 20 s) and the cron sweep (20 min to 48 h, 50 a run, `pmap` 5) apply a paid order whose callback never came, through the same cross-checks | |
| | 2249 | Checkout no longer needs a phone for Geidea; the customer object holds name and email only; `provider_error` (the page reads it and the old `paymob_error`) | |
| | 2250 | Account deletion removes both providers' card and last-checkout keys and calls Geidea's delete-token; "remove card" does the same; the data download names provider references, never a token | |
| 4 Renewals | 2251 | Renewal through Geidea MIT at `priceFor` (lock rule 1706 kept); the rule 1956 re-check unchanged; a pending charge settled by the reconciliation | Step 3; F1 answered |
| | 2252 | A declined renewal, 750.005 or an error leads to past due, grace, then lock, exactly as rules 710-714; 750.005 also drops the card | |
| | 2253 | Reserved: Geidea Subscriptions fallback (6.4), only if F1 says so | |
| 5 Refunds | 2254 | Full console refund through Geidea: once, voids the payment, ends the plan (rule 1300) and the founding seat and lock (rule 1708); `not_online` / `refund_failed` alongside the old codes | Step 3 |
| | 2255 | Partial refund (6.5), only on the founder's yes to F5 | F5 |
| | 2256 | A refund made in Geidea's portal changes nothing on the account (rule 1301 parity) and writes `geidea_external_refund` for the founder | |
| 6 Config and copy | 2257 | variables.md section 4b, `.env.example`, the Integrations row `geidea` (names and presence only), flows section, permissions rows, `docs/system/tests/2230-geidea-swap.md` | Step 3 |
| | 2258 | Customer copy: privacy text and the help "processors" answer name Geidea as the card processor; the billing page says "payment gateway", not a brand; `?pay=return` read alongside `?paymob=return`. No claim that payment is live until it is | Lawyer for the legal drafts |
| 7 Contract | 2259 | Release 2: Paymob removed (section 5), after live Geidea payments are checked and the read-only key count shows 0 `paymob:*` keys | Founder |

Going live is not a build step. It is the founder's, in this order:
1. Test credentials go in staging's hPanel.
2. A full run on staging with the G2 test cards: plan, pack, decline, save card, renewal, full refund, partial refund if built, and a lost callback recovered by the return page.
3. The release pull request from `main` to `production`, merged by the founder.
4. Live credentials and `GEIDEA_LIVE=1` go in production's hPanel, on his word.
5. One real payment and its refund.

## 10. Open questions

### For the founder

- **F1. Renewals.** Our own monthly charge with a saved card (self-run MIT, keeps every money rule in our code), or Geidea's Subscriptions (6.4 fallback)? Default: our own, if Geidea confirms G1-G3 below.
- **F2. VAT.** Prices are shown ex-VAT and the code adds 15% (`PAYMOB_CHARGES_VAT = true`, renamed `CHARGES_VAT`). The company cannot charge VAT without a VAT number. Is the number issued before the first card payment? The accountant decides; until then the build keeps the constant and the go-live step checks it.
- **F3. Payment methods in v1.** Cards only (mada, Visa, Mastercard), or also Amex, Apple Pay (needs Geidea's domain file on thakeen.com) and STC Pay? Default: mada, Visa and Mastercard only.
- **F4. Customer data sent to Geidea.** Name and email only (default), or also the phone?
- **F5. Partial refund.** Build it (rule 2255) so the founding offer's 7-day refund (paid minus used credits) can be paid out? Default: yes, ending the plan, as the founding spec says. F5b: is the partner's commission voided in full or pro rata on a partial refund? Default: in full.
- **F6. Rule 1301 carry-over.** A refund made in Geidea's portal still changes nothing on the account. Keep that (default), or should a portal refund end the plan too?
- **F7. Confirm** that no `PAYMOB_*` value was ever set on production or staging, so no Paymob record exists.
- **F8. Paymob account.** Close it, or keep it unused until the contract release? Default: keep until release 2.
- **F9. Contract with Geidea.** Fees (mada vs credit cards), settlement days to the IBAN, any monthly minimum, and the data processing agreement for the privacy policy (lawyer).

### For Geidea's sales and integration team

- **G1.** Is MIT (`initiatedBy: "Merchant"`, `pay/token`) available on our KSA account, and does it work on **mada** cards?
- **G2.** For a fixed monthly charge that we schedule ourselves, is `agreementType` `Unscheduled` (the guides) or `Recurring`? Do the agreement fields go at the top level or in `cofAgreement` (the guide and the reference disagree)?
- **G3.** Does the hosted page ask the cardholder's consent to store the card when `cardOnFile: true`, or must our page show that consent text?
- **G4.** Test environment: is there a KSA sandbox host, or are test credentials used on `api.ksamerchant.geidea.net`? Does every order made with test credentials carry `isTest: true`?
- **G5.** Can test and live credentials be told apart (a prefix, a field, a different host), so our code can refuse a live key outside production before any charge?
- **G6.** The exact `timestamp` format to send and sign. Does `merchantReferenceId` have to be a UUID?
- **G7.** Callbacks: retries after a non-2xx answer (how often, for how long), the timeout, the answer you expect, and the source IP addresses if published. The callback's top-level `timeStamp` format, and does Geidea check its freshness?
- **G8.** Where do `responseCode` and `detailedResponseCode` sit on a paid order's callback: on the order, on the last `Pay` transaction, or both?
- **G9.** Refunds: the window in days, whether refunds must be switched on for our account (800.005), whether a refund triggers a callback to the refund's `callbackUrl` and in what shape, and the fees on a refund.
- **G10.** The delete-token call's HTTP method and signature.
- **G11.** Can the session's expiry be set longer than 15 minutes?
- **G12.** E-invoicing: does Geidea offer ZATCA (Fatoora) invoices, or is that ours (`invoiceForPayment` stays our seam)?

## 11. Not in this design

- Code: none is written until the founder says to build. The build order is section 9.
- Apple Pay, STC Pay, Tabby, Tamara: later, each on the founder's decision (F3).
- Agency billing stays by contract and by hand.
- ZATCA e-invoicing stays the empty seam (`src/lib/invoice.ts`).
