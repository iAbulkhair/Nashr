---
name: add-a-payment-provider
description: Use when adding or changing a payment provider adapter behind the PaymentProvider seam (Paymob exists, Geidea is in progress) or its webhook.
---

# Add a payment provider

Money code is the most guarded in the repo. Billing talks to a provider only through the `PaymentProvider` interface in `src/lib/payments/provider.ts`. `src/lib/payments/index.ts` picks the provider (`paymentProvider()`) and says whether payments are on (`paymentsEnabled()`). Paymob is the only adapter on `main` (`src/lib/paymob.ts`). Geidea work exists on the local branch `claude/geidea-r1` (rules 2700-2729): an adapter, a webhook route and a rule file, off by default. Check that branch with `git log claude/geidea-r1` before starting; do not rebuild it.

## Steps

1. Read `docs/system/flows.md` (billing sections), `docs/system/costs.md` and the interface comments in `src/lib/payments/provider.ts`: `createCheckout`, `savedCard`, `parseEvent`, `verifyWebhook`, `parseTransaction`, `parseCardToken`, refunds, and `PaymentError`.
2. Write the adapter in `src/lib/<provider>.ts` implementing every method. It never reads a plan price: the amount comes from `priceFor` in `src/lib/billing.ts`, which uses `src/lib/pricing.ts` (change-a-plan-or-price).
3. Register it in `src/lib/payments/index.ts` behind a switch that is off by default. Account for the `name` union in `provider.ts` and for every place that matches on it.
4. Webhook route `src/app/api/billing/<provider>/webhook/route.ts`, modeled on `src/app/api/billing/paymob/webhook/route.ts`:
   - public route with `allow` and `clientIp` from `src/lib/rate.ts`, `retryLater` on limit, a body cap through `readCapped` in `src/lib/read-capped.ts`;
   - verify the signature over the raw body with `verifyWebhook`, compared with `sameSecret` (`src/lib/secret.ts`), before parsing;
   - answer fast and idempotently: apply once per transaction id.
5. Add the webhook path to `CROSS_SITE_EXEMPT` in `src/lib/csrf.ts` (a provider posts without our cookie).
6. `applyTransaction` and `handlePaymobCallback` in `src/lib/billing.ts` keep three guarantees; your path must keep them: the amount is checked against our own price, the account comes from our own stored intent (never from provider text), and a transaction applies once.
7. Keys: any new Redis key goes in `src/lib/keys.ts` (add-a-workspace-scoped-feature). Card tokens are stored only as the provider returns them, never a card number.
8. Variables: add each environment variable name to `docs/system/variables.md` section 4 (billing) and `.env.example`, secret or not as that file says (release-and-env-vars). Values are entered by the founder in hPanel, never in chat or the repo.
9. Docs and rules: update `docs/system/flows.md`, `permissions.md` and add `docs/system/tests/NNNN-<provider>.md` with a free rule block (add-a-feature, numbering step).
10. Tests: model on `tests/paymob.test.ts`, `tests/payment-storage-seams.test.ts` and `tests/founding.test.ts`. Cover a bad signature, a replayed event, a wrong amount, a foreign account id, and the off switch (route answers as if the provider is not configured).

## Checks

`npx vitest run tests/paymob.test.ts tests/payment-storage-seams.test.ts tests/billing*.test.ts`, then `npm run check` and `npx next build`.

## Traps

- Never run a real charge in a test or on staging without the provider's test mode and the founder's yes.
- Never log a webhook body, a signature or a key.
- Trusting the amount or plan in the webhook payload. Recompute from our own intent.
- Turning the provider on in code. The switch is an environment variable the founder sets, and turning it on live is a release (release-and-env-vars).
- The founder decides prices and trial rules (the trial and founding perks are product decisions, not yours).
