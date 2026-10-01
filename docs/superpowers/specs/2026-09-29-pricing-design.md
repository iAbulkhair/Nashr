# Thakeen plan pricing — design

Decided with the founder on 2026-09-29 in a question-by-question session. Every number below is arithmetic over
`RATES` in `src/lib/usage.ts`, the measured prompt sizes in `docs/system/costs.md`, and the market research listed in
section 3. The one assumption is the "typical" usage mix in section 5, and it is marked as such.

**Status (2026-09-30):** phase 1 of the plan is built on branch `claude/pricing-phase-1`: the tier prices, credits and
seats in one table (`src/lib/pricing.ts`), the Agency deal floor, the 60% floor as a test, unlimited brands with a
9-credit setup for each added brand, and the public numbers rendered from the table. It deploys after the owner's
blocking items (`docs/Owner_Tasks_AR.md` section ح3). The 7-day trial, the chat allowance, outputs instead of credits,
the human anchors and payments are later phases; until then the code keeps a 3-day, 50-credit trial.

**Status (2026-10-01):** phase 2's chat allowance is built (rules 308-316 in `docs/system/tests.md`): 250 / 650 / 1,300
messages a month and 30 for the whole trial, counted per account in code before each message, with two founder
decisions of 2026-10-01 that amend rule 1 below: when the messages run out the owner of a paid plan may turn "continue
on credits" on, and one message may cost at most $0.35 in model calls. Chat stays on Opus until the Sonnet eval (rule
2, section 7 item 3). The review of the build the same day removed the first build's hold: nothing is taken before a
message on credits, the balance only has to hold 5 credits, and the metered cost is billed after the reply.

## 1. Decision in one paragraph

Prices are set from value and the market, not from API cost. API cost only sets a **floor**: every task type keeps at
least 60% gross margin on the cheapest self-serve credit. Text generation is never priced as "cost plus a markup";
media (image and video) is, per model, because the owner picks the model and sees its credit price. Three self-serve
tiers — Starter 299, Pro 499, Business 999 SAR a month plus VAT — and a sales-led Agency tier. Every paid tier is
compared on the pricing page to a human alternative, never to ChatGPT.

## 2. Tiers

| | Starter | Pro | Business | Agency |
|---|---|---|---|---|
| Price (SAR / month, + VAT) | 299 | 499 | 999 | Contact us |
| Compared against | a freelancer | a freelancer or small agency | a junior hire | staff hours per client |
| Credits / month | 300 | 700 | 1,500 | custom, never cheaper than Business (999 / 1,500 ≈ 0.666 SAR / credit) |
| Chat messages / month | 250 | 650 | 1,300 | custom |
| Seats (owner included) | 1 | 3 | 7 | paid extras |
| Brands | unlimited | unlimited | unlimited | unlimited |
| Net revenue (USD at 3.75) | $79.73 | $133.07 | $266.40 | ≥ Business rate |
| Revenue per credit | $0.266 | $0.190 | $0.178 | ≥ $0.178 |

- **Trial:** 7 days, 50 credits, no card, about 30 chat messages, 3 seats, no video.
- **Agency** absorbs today's `enterprise` plan: annual contract, at least about 2,000 SAR a month, credits never below
  the Business rate; agencies pay for extras (more seats, client-ready reports, white-label, SLA) instead of cheaper
  credits.
- **Pricing page** shows outputs ("≈ N posts or M articles a month"); credits stay the internal ledger. ChatGPT appears
  only in a feature comparison and as the trial's hook, never as a price anchor.

## 3. Evidence (checked 2026-09-29)

**Comparable AI tools (vendor pricing pages, monthly):**

| Tool | Tiers | Value metric |
|---|---|---|
| Enrich Labs | $39 (200 cr) / $99 (700) / $199 (2,000) / custom; 25% off yearly; 3-day trial | credits, brands |
| Predis.ai | $24 / $55 / $212; 3-day trial with card | credits, brands |
| Ocoya | $29 / $79 / $199; yearly = 2 months free; 7-day trial | users, profiles, AI credits |
| Jasper | $69 per seat ($59 yearly); 7-day trial | seats |
| Copy.ai | $29 (5 seats) | seats, workflow credits |
| Higgsfield | $15 / $39 / $99 (yearly) | credits |
| HubSpot Marketing Starter | $20 per seat + 500 credits | seats + credits |
| ChatGPT | Go SAR 35, Plus SAR 90, Pro from SAR 430 | seat |
| BeTrend (Saudi) | SAR 49 / 69, tax-inclusive | points |
| Adly AI | $19 / $29 / $49 / $119 | credits, brands |

Sources: enrichlabs.ai/pricing, predis.ai/pricing, ocoya.com/pricing, jasper.ai/pricing, copy.ai/prices,
higgsfield.ai/pricing, hubspot.com/pricing/marketing, chatgpt.com/pricing, betrendai.com, getadly.com.

**Human alternatives in Saudi Arabia:**

- Agency entry packages: SAR 500–2,500 a month for about 8–12 posts on one platform (zeinahost.com, wamidah.com,
  naktublak.com, mediastationsa.com, sigmadsllc.com).
- Freelancers: typically SAR 940–2,500 a month (Mostaql postings 1273147, 1277385, 1258160; low confidence, no rate
  survey found). Micro-gigs from SAR 94.
- Hire: since 2026-04-19 a Saudi marketing specialist counts toward Saudization only if paid at least SAR 5,500 a
  month (hrsd.gov.sa). Business at 999 is 18% of that floor, before GOSI and benefits.

**VAT:** ZATCA's Guideline on Professional Services (v3, May 2026, citing Art. 25 of the GCC VAT Agreement) says prices
announced to the public must include VAT. No B2B exception was found.

## 4. The margin floor

- Cheapest self-serve credit: Business, $266.40 / 1,500 = **$0.1776**.
- 60% floor: a credit may cost at most 0.4 × $0.1776 = **$0.0710**.
- Types over it today, reweighted: `weekly_plan` **1 → 2** credits ($0.0444 / credit), `followup_seq` **3 → 4**
  ($0.0665). `article` and `weekly_report` pass at $0.0700 with 1.4% headroom: they are the first to watch when an
  output grows or a model price moves.
- As implemented (2026-09-30, `src/lib/task-costs.ts` and `tests/pricing-floor.test.ts`): the ceiling is $0.07104.
  Cron-driven types (the Sunday plan and every routine's type) are checked on a cold cache, since the cron usually
  finds the workspace block uncached (founder decision 2026-09-29). Cold, `weekly_report` at 2 credits cost $0.0918, so
  it went **2 → 3** ($0.0612 cold); the cold Sunday plan at 2 is $0.0662. On a hit `weekly_plan` is $0.0446 and
  `followup_seq` $0.0666. `article` ($0.0702, 1.1% headroom) is the only type above 95% of the ceiling. A one-item chat
  draft ($0.0716 for 1 credit) stays at 1 credit as a named exemption capped at that figure.
- The floor is recomputed whenever a plan price, a plan's credits or a model rate changes. It is a test, not a comment
  (see the plan).

## 5. Unit economics per tier

Cost per credit: best case all `social` ($0.018), **typical $0.030 (assumption:** a realistic month of 4 weekly plans,
8 social batches, 2 ad sets, 4 WhatsApp batches, 4 articles, 4 reports and 40 images comes to $0.024; rounded up), worst
case all `article` / `weekly_report` ($0.070). Chat on Sonnet at about $0.032 a message (estimate: an Opus turn at about
$0.08, divided by the 2.5× rate gap), full allowance used. Every row assumes 100% of credits and chat are used.

| | Starter | Pro | Business |
|---|---|---|---|
| Credit cost best / typical / worst | $5.34 / $9.00 / $21.00 | $12.46 / $21.00 / $49.00 | $26.70 / $45.00 / $105.00 |
| Chat cost | $8.00 | $20.80 | $41.60 |
| Total cost best / typical / worst | $13.34 / $17.00 / $29.00 | $33.26 / $41.80 / $69.80 | $68.30 / $86.60 / $146.60 |
| **Gross margin best / typical / worst** | **83% / 79% / 64%** | **75% / 69% / 48%** | **74% / 68% / 45%** |
| Margin on credits alone, worst | 74% | 63% | 61% |
| Generation output tokens / month | 141k – 555k | 329k – 1.30M | 705k – 2.78M |

Not included: payment provider fees (provider not chosen) and fixed hosting (Vercel, Upstash, Blob). The worst total
needs every credit spent on articles and every chat message used at once; the founder console's margin column (red
under 50%) flags it. As built on 2026-10-01 chat still runs on Opus, so the chat row above holds only after the
Sonnet switch: `docs/system/costs.md` section 4.1 gives the same allowances on Opus ($20.00 / $52.00 / $104.00 at about
$0.08 a message) and at the $0.35 ceiling, where a full Starter allowance costs more than Starter earns.

## 6. Rules

1. **Chat allowance.** 250 / 650 / 1,300 messages a month by tier, about 30 in the trial. When it runs out, chat pauses
   until the next month or a top-up. Generation from chat (`generate_content`, `draft_items`, `generate_image`) keeps
   charging credits as today.
   **Amended 2026-10-01 (founder decisions, as built):** the trial's 30 are granted once for the whole trial; a message
   is one turn the owner sends, counted per account (every seat, brand and connected app share it) before the turn, and
   a turn that fails is not counted. When the messages run out chat pauses until the 1st (UTC), or on a trial until the
   owner subscribes; top-ups wait for phase 6. Instead, the owner of a paid plan may turn "continue on credits" on: each
   extra message then needs at least 5 credits in the balance (nothing is taken before it) and, after the reply, is
   billed its metered model cost at the floor rate ($0.0710 a credit, so the 60% margin of section 4 holds), never more
   than 5 credits; a failed message is not billed. What a message usually costs is not measured yet (on Opus a turn is
   estimated near $0.08, above one credit), so no copy states it. Every message, inside the allowance or not, is capped
   in code at **$0.35 in model calls** (each call's output is limited to what is left, and the thread the model reads
   is trimmed), which is what sets the 5-credit bound (ceil($0.35 ÷ $0.0710)).
2. **Chat model.** Conversation turns move from Opus to Sonnet only after the golden eval plus a Gulf-dialect chat check
   pass on Sonnet. Generation stays on Opus.
3. **Media.** `credits = ceil(total cost ÷ $0.0710)`, where total cost = provider price + Blob storage + 10% buffer for
   failed renders. Recomputed per model when a provider changes price.
4. **Unlimited brands, with two guardrails.** The first brand's onboarding stays free; each additional brand's onboarding
   costs **9 credits** (ceil($0.60 ÷ $0.0710)), shown before the owner confirms. The Sunday weekly plan runs by default
   only for the first brand; added brands opt in.
5. **Top-ups.** 1 SAR per credit + VAT, packs of 100 / 300 / 1,000, valid 90 days, spent after the monthly allowance.
   Monthly credits never roll over. Worst-case top-up margin 74%.
6. **Annual.** 2 months free; credits still arrive monthly, never 12 months at once.
7. **Launch offer.** The first 100 *paying accounts* keep their launch price for 12 months, plus personal onboarding.
   Replaces "the first 100 brands get two months free on Pro" in `src/lib/i18n.ts`.
8. **Seats.** 1 / 3 / 7 including the owner; trial 3; Agency custom. Seats share the account's credits, chat allowance
   and brands, so a seat adds no model cost.
9. **Agency deals.** Credits never cheaper than the Business rate, 999 SAR for 1,500 credits (≈ 0.666 SAR a credit;
   the earlier "0.67" was that rate rounded). The code checks it in whole numbers, price × 1,500 ≥ credits × 999, with
   at least 999 SAR and 1,500 credits, so a deal at exactly the Business rate passes; a rounded 0.67 would have refused
   it. Annual. Extras are what agencies pay for. The "about 2,000 SAR a month" minimum is sales guidance, not enforced.
10. **VAT display.** Prices shown "+ VAT", **conditional on an accountant confirming it is allowed in Saudi Arabia.** If
    not, the fallback is 299 / 499 / 999 including VAT: net 260 / 434 / 869 SAR, cheapest credit $0.1544, floor
    $0.0618, and `article` and `weekly_report` then need 2 → 3 credits. As implemented (`weekly_report` is already 3,
    and cron types are checked cold), the floor test says `article`, `followup_seq` and the cold `weekly_plan` would
    fail and must be repriced before `PRICES_INCLUDE_VAT` is switched on.
11. **GCC countries.** Each country gets its own price list in local currency, set against that country's human
    alternative (agency packages, freelancer rates, junior salary), then clamped to the floor. Launch with Saudi Arabia
    and the UAE. Floors in USD: Starter ≥ $52.50, Pro ≥ $122.50, Business ≥ $262.50 (credits × $0.175). Only Starter
    has real room to go below the Saudi price.
12. **Review.** At 50 paying accounts or 90 days, whichever comes first. Measure trial-to-paid conversion, tier mix,
    share of credits used, real $/credit from `byKind.generate`, top-up rate, and a willingness-to-pay survey to the first
    50. Increases apply to new customers only; the price-locked first 100 are untouched.

## 7. Open before launch

1. Accountant: "+ VAT" display in Saudi Arabia; VAT registration or reverse charge for each other GCC country.
2. Payment provider that takes SAR, AED, KWD, QAR, BHD and OMR with local cards (mada, KNET, Benefit). Tap appears to
   cover more of the GCC than Moyasar; verify before choosing.
3. Sonnet chat eval (golden set + Gulf-dialect check).
4. UAE price research, same method as Saudi.

## 8. What this replaces

`PLAN_PRICE_SAR` (149 / 399 / 799), `PLAN_CREDITS` (200 / 700 / 2,000), `BRAND_LIMIT` (1 / 1 / 5), the 3-day trial, chat
free in credits and bounded only by 40 messages an hour and 200 a day (replaced on 2026-10-01 by the monthly chat
allowance of rule 1, with those limits kept as a burst limit in front of it), the "SAR 99 / seat" line and the "two
months free" launch offer. The
current prices were an SAR copy of Enrich Labs' $39 / $99 / $199.

Implementation plan: `docs/superpowers/plans/2026-09-29-pricing.md`. Teams (seats) design:
`docs/superpowers/specs/2026-09-29-teams-design.md`.
