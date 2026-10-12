# 04-G Billing, payments, legal (Thakeen 360, 2026-10-11)

Scope: Paymob KSA (#279), credits, top-ups, refunds, affiliates, company papers (#47), accountant (VAT), lawyer, prices on the site. Read-only study on origin/main 3bf67673, compared with origin/production 487984f4. Machine-readable findings: `raw/findings-G.jsonl` (G-001 to G-017).

## Summary

1. No customer can pay online today. Paymob is built, tested with mocks, in production code, and gated off. The env state is unknown today and was empty on 2026-10-08.
2. The three papers that unblock money (commercial registration, VAT number, business IBAN) have no recorded status. #47 has no comments.
3. Code charges 15% VAT on top of every online payment while VAT registration and e-invoicing (ZATCA seam returns null) are unresolved. Do not enable Paymob before the accountant answers.
4. Legal text is stale: privacy and terms still name Vercel and Vercel Blob, omit Paymob, Hostinger, Composio, and no entity or governing law. No lawyer engaged (#48).
5. Pricing 299/499/999 SAR + VAT and affiliates (15% x 4 months, 30 days, 15% partner-code discount) are implemented and match the live site. Copy conflicts remain (VAT wording, "first 100 get two months free", trial 3 vs 7) and the support address hello@nashr.ai is dead.

## Current state

| Item | Code | In origin/production | Live behaviour | Status |
|---|---|---|---|---|
| Paymob adapter, checkout, webhook `/api/billing/paymob/webhook` | yes, `src/lib/paymob.ts`, `src/lib/billing.ts` | yes | route returns 404 until the gate opens | dormant (VERIFIED code; env UNVERIFIED today) |
| Gate env names | `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID_CARD`; optional `PAYMOB_INTEGRATION_ID_MOTO`; live keys also need `PAYMOB_LIVE=1` | | | none confirmed set |
| Callback signature | HMAC-SHA512, 20 txn fields and 8 token fields, constant-time `sameSecret`, 64KB body cap, 240/min/IP | yes | | VERIFIED by reading; never run against a real callback |
| Idempotency | done marker, lock, deterministic payment id, one renewal attempt per account per Riyadh day | yes | | VERIFIED by reading |
| Saved-card renewal (MIT/Moto) | `renewPaymob` from daily cron, 7-day grace, then lock | yes | | needs the Moto integration; Paymob answer unknown |
| Refund | admin console action, `refundPaymobPayment` | yes | | works on payment record only (G-005) |
| Credits | balance, top-up lots, holds on user record under `withUserLock` | yes | | no append-only ledger (G-012) |
| Top-ups | 1 SAR per credit, packs 100/300/1000, valid 90 days | yes | manual only while Paymob off | dormant online |
| Plans | 299/499/999 SAR + VAT; credits 300/700/1500 (Agency set by contract) | yes | live pricing page shows 299, 499, "excluding VAT" | VERIFIED |
| VAT / invoice | 15% added on top; `invoiceForPayment` returns null | yes | | no tax invoice is issued |
| Affiliates | 15% for 4 months on pre-VAT payment, 30-day window, partner code 15% off first month, manual payout from SAR 200 | yes | `/en/affiliates` shows 15% for 4 months | working, manual payout |
| Company papers (#47) | n/a | n/a | | unknown |
| Accountant, lawyer (#48) | n/a | n/a | | not engaged as far as the repo shows |
| Privacy / terms | `src/lib/legal.ts` | yes | still names Vercel Blob | stale |

## Findings (P0 first)

P0
- G-001 No live payment path. Open the Paymob KSA account, set four env names on staging, run one test payment.
- G-002 Company papers unknown. One line per paper in Owner_Tasks_AR; ask Paymob which documents it accepts for the founder's status.
- G-003 VAT gate. Code hard-wires +15% and issues no invoice. Accountant must answer registration timing, "+VAT" display and e-invoice before go-live.

P1
- G-004 Eight open Paymob questions (Moto/MIT on mada, tokenisation, refunds, retries) and zero real sandbox runs.
- G-005 Refund voids payment and commission but leaves plan, paid-through date and saved card active. Add cancel plus test.
- G-006 Privacy/terms stale (Vercel Blob, missing processors, no entity). Lawyer review (#48) not done.
- G-007 `hello@nashr.ai` has no MX or A record. Used on the billing page, top-up card and waitlist message.
- G-008 Copy conflicts: Razan says VAT included, pricing says excluded; "first 100 get two months free" has no mechanism (#193).
- G-009 Code and live site are right on prices; deck and model scripts still carry 149/399/799 (workstream I).
- G-010 Trial 3 days in product, 7 in PRD and deck (#77, #191).
- G-011 Affiliates implemented as decided; partner terms await the lawyer.
- G-015 No accountant or lawyer named.

P2
- G-012 No append-only ledger; `withUserLock` uses plain unlock, 10 s TTL (#158).
- G-013 Hand-set plans refill monthly without a payment record (#9).
- G-014 Stale docs and issues (MobPay in Owner_Tasks, #9, #8, #19).
- G-016 Empty generation may still charge (#79): UNVERIFIED.
- G-017 Renewal depends on the Hostinger daily cron; no alert on a missed run.

## What could not be verified and why

- Current hPanel env vars: not readable; no unauthenticated probe. Last known list (2026-10-08) had 11 variables, none PAYMOB_*.
- Paymob account, sandbox keys, Moto integration, answers to the 8 questions: not in repo, issues or logs.
- Whether any paper exists (CR, VAT, IBAN) or any professional has been contacted: not recorded.
- Real HMAC behaviour on a live callback: only mocked tests exist.
- Paymob fees and accountant/lawyer fees: not recorded, so costs are "unknown".
- Whether the live 999 and Agency rows match code: only 299 and 499 were read on the live page.
- Issue #79 trace end to end: not done.
