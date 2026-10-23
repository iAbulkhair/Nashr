---
name: change-a-plan-or-price
description: Use when changing a plan's price, credits, seats, brand limit, chat allowance or margin rule, or the copy that shows them.
---

# Change a plan or price

Prices, credits and limits come from one table: `src/lib/pricing.ts`. It imports nothing, so client code may use it (`tests/client-bundle.test.ts` guards that). The founder decides prices and the 60 percent margin floor; an agent proposes, the founder says yes in chat.

## What lives in `src/lib/pricing.ts`

`PLAN_PRICE_SAR` (trial, starter, pro, business), `PLAN_CREDITS`, `PLAN_SEATS`, `PLAN_BRANDS`, `CHAT_ALLOWANCE`, `MARGIN_FLOOR`, `VAT_RATE`, `PRICES_INCLUDE_VAT`, and the helpers `allowanceOf`, `priceOf`, `seatLimit`, `dealRespectsFloor`.

## Steps

1. Read `docs/system/costs.md` (what a credit costs us) and the pricing sections of `docs/system/flows.md`. Work out the margin per plan at full use: it must stay at or above `MARGIN_FLOOR`. `dealRespectsFloor` is the code check; `tests/pricing-floor.test.ts` pins it.
2. Change the value only in `src/lib/pricing.ts`. Never copy a number into another file.
3. Find every consumer and make sure it reads the table: plan cards in `src/lib/i18n.ts`, `src/lib/help.ts`, `src/lib/pages-industry.ts`, `src/lib/pages-compare.ts`, `src/lib/home-ld.ts`, `src/lib/lifecycle.ts`, `src/lib/founding.ts`, `src/lib/billing.ts`, the admin panels and the billing page. Search with `grep -rn "299\|499\|999" src` before and after; a literal price in copy is a bug (`tests/pricing-copy.test.ts`, `tests/plan-cards.test.ts`).
4. Checkout: the amount sent to the provider is `priceFor` in `src/lib/billing.ts` and is verified again when the webhook arrives (add-a-payment-provider). Do not change what existing subscribers pay in the same step; the new price applies at their next renewal only if the founder says so, and renewal anchors are in `src/lib/credits.ts` (rule 2936).
5. Payment links: the `PAY_LINK_*` variables are named in `docs/system/variables.md` section 4. A price change may need new links made by the founder in the provider dashboard. Names only in the repo.
6. VAT: prices are shown the way `PRICES_INCLUDE_VAT` says. Do not add VAT in one place and not another.
7. Existing customers: a stored plan record keeps its old limits until migrated. If you add a field (a new limit), it is a stored-shape change (change-a-stored-shape): code reads the new field with a default derived from the plan.
8. Copy: update Arabic and English together (add-arabic-and-english-copy). No invented discounts, "most popular" claims or customer counts. Offers such as the partner code and last-day offer follow the founder's recorded decisions; do not invent new ones.
9. Docs: `docs/system/costs.md`, the pricing flow in `docs/system/flows.md`, and a rule file under `docs/system/tests/` (add-a-feature, numbering step).
10. Tests: `tests/pricing.test.ts`, `tests/pricing-floor.test.ts`, `tests/pricing-copy.test.ts`, `tests/plan-cards.test.ts`, plus any billing test that names the changed number.

## Checks

`npx vitest run tests/pricing.test.ts tests/pricing-floor.test.ts tests/pricing-copy.test.ts tests/plan-cards.test.ts tests/client-bundle.test.ts`, then `npm run check` and `npx next build`.

## Traps

- Editing a number without reading how credits are held and refunded; a lower credit price can break the floor for chat.
- Changing the price on the live site before the payment link and the checkout amount match. This goes out as a release PR the founder merges (release-and-env-vars).
- Making the table import something. The client bundle test fails.
