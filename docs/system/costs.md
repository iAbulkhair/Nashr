# What a request costs, and where the money goes

Written 2026-09-20; sections 1, 3, 4.1 and 5 updated on 2026-10-02 when chat moved to Sonnet 5.5 under a $0.14 ceiling; sections 1, 3, 3.1, 4 and 5 updated on 2026-09-30 for pricing phase 1 (`src/lib/pricing.ts`, `src/lib/task-costs.ts`); sections 1, 3, 5 and 6 updated and section 4.1 added on 2026-10-01 for pricing phase 2 (the chat allowance, the owner's "continue on credits" switch, the $0.35 per-message ceiling and the history guard: `src/lib/chat-allowance.ts`, `src/lib/chat-budget.ts`), and again the same day after its review (no credits held before a message on credits: the balance is checked and the metered cost billed after the reply; the first call's thread shortened to fit; the founder console's cost per message over every message sent). Every number in the tables is arithmetic over two inputs: the list prices in `src/lib/usage.ts`
(`RATES`) and the prompt sizes the code actually builds. Nothing here is a guess about Anthropic's billing; the guesses
are only in the *output* token counts, and those are marked as such. Real per-account numbers are metered and shown in
the founder console — see "Where the real numbers live" at the end.

## 1. The model calls the product makes

| Call | Model | Where | Charged to the customer |
|---|---|---|---|
| `generate` | `claude-opus-5`, `max_tokens` 16000, effort medium | `src/lib/noor.ts` `generate`; every paid batch reaches it through `generateBatch` (`src/lib/generate-batch.ts`), the golden set directly | credits, per `TASK_COST` (a chat `draft_items` pays `countCost`), charged in `generateBatch` before the call |
| `review` | `claude-sonnet-5`, 16000, effort low | `noor.ts` `critique`, runs after every batch unless governance turns it off | free (inside the batch) |
| `judge` | `claude-sonnet-5`, 8000, effort low | `src/lib/judge.ts`, runs after the response via `after()` | free |
| `xreview` | `claude-sonnet-5`, 4000, effort low, one call per reviewing agent | `noor.ts` `crossReview` (since 2026-09-30): the cross-agent review of `gtm_plan` (two calls, Razan and Majed), `growth_experiments`, `retention_play`, `board_deck`, `decision_memo`, `strategy_review` (Razan) and `pricing_review` (Majed); no other type; skipped when governance turns it off, in golden runs, and with less than 60 s of the caller's deadline left; one attempt of at most 45 s per call, no SDK retries. **Metered to the reviewing agent**, not the author: it is the cost of Razan's and Majed's review work | free (inside the batch) |
| `chat` | `claude-sonnet-5-5` (`CHAT_MODEL`; `claude-opus-5` until 2026-10-02), effort medium, adaptive thinking, **up to 5 calls per turn** (tool loop); since 2026-10-01 each call's `max_tokens` is what is left of the **$0.14 per-message ceiling** (`CHAT_TURN_MAX_USD`; $0.35 on Opus until 2026-10-02) after the turn's cost so far and an upper estimate of the call's input, at most 8,000, and no call is made with less than 2,048 left (`CHAT_MIN_OUT`, `nextMaxTokens`, `src/lib/chat-budget.ts`); the input estimate counts 3 characters a token (`CHARS_PER_TOKEN_EST`, below the measured 3.3 so it stays high) and prices the cached prefix (the tools and system blocks 1-2) as a cache write on the first call and as a cache read on later ones; the thread is trimmed to the newest 16 messages within 24,000 characters (`trimHistory`), then shortened from its oldest end until the first call has at least 4,000 output tokens (`CHAT_FIRST_MIN_OUT`, `fitFirstCall`); a workspace too large even for the newest message alone gets no model call, a reply that says so, and is not counted | `src/lib/chat.ts` | **included** up to the plan's monthly chat messages (`CHAT_ALLOWANCE`: trial 30 for the whole trial, starter 250, pro 650, business 1,300; section 4.1). Past them chat pauses until the 1st (UTC), unless the owner of a paid plan turned "continue on credits" on: then a message goes ahead only when the balance is at least `chatOverflowHold()` = ceil($0.14 / $0.07104) = **2 credits**, nothing is taken before the turn, and after the reply it is billed its metered cost at the floor rate ($0.07104 a credit, section 4), at most 2 credits and at most what the balance still holds, the remainder under one credit carried to the next message (`settleChatOverflow`, `src/lib/credits.ts`); a failed message is not billed |
| `onboard` | `claude-opus-5` × 3 parallel, 10000 + 12000 + 12000 | `src/lib/onboard.ts` | **nothing** for the first brand (the default scope); **9 credits** for each added brand since 2026-09-30 (`ONBOARD_EXTRA_BRAND_COST`, `src/lib/pricing.ts`), charged to Noor in that brand's scope before the stream and refunded when the brand is not saved; once per workspace |
| `image_prompt` | `claude-sonnet-5`, 400, effort low, one attempt of at most 20 s, no SDK retries | `src/lib/media/prompts.ts` (image **and** video prompts; video is metered under this kind too, spec A18) | charged with the render (section 3.1); a fixed template, and no model call, while Claude is paused |

Reem phase 3 B2a (2026-10-05, bookings in from Cal.com and Calendly) makes no model call and charges no credits: it is webhook handling, the owner's setup (Calendly's two API calls) and revocation only, so it adds no row above. A booking creates an open task through `createItem` as the rule, which spends no credits (it counts against the owner's `sec:create` allowance of 200 a day, and a link's own cap of 60 new items a day).

## 2. Prompt size, measured

`systemPrompt` (`noor.ts`) builds three blocks. The first two carry `cache_control`, the third never can (it holds
today's date, the live calendar, the owner's preferences and, since 2026-09-29, the recent feedback on the agent's own
work from `feedbackFor`, all of which move).

| Block | Characters | Cacheable |
|---|---|---|
| fixed (rules + the agent's playbook from `content/skills/`) | 10,374 (Razan) – 16,657 (Majed) | yes |
| paid ads slice from `content/skills/ads.md` (since 2026-10-05: Noor, Faris, Razan, Dana, Layan only; inside the fixed block) | about 4,400 (Dana) – 5,900 (Faris) | yes |
| growth slice from `content/skills/growth.md` (since 2026-10-05: Noor, Sami, Faris, Dana, Layan only; inside the fixed block) | about 4,300 (Dana) – 6,000 (Noor) | yes |
| workspace (brand file + up to 5 × 6,000 chars of memory files) | 1,500 with an empty workspace, 31,500 at the cap | yes |
| today (date, seasons, up to 30 preferences, recent feedback) | 500 – 8,800 (the feedback block is at most about 2,300 characters: counts, 5 notes of 200, 3 judge flags of 120; absent when there is none or learning is off) | no |

At roughly 3.3 characters per token for this Arabic/English mix, a full batch prompt is **≈ 8,700 input tokens**: about
7,500 of them cacheable and about 1,200 fresh every time.

## 3. Cost of one batch

Recomputed on 2026-09-27 for Sonnet 5 at $2/$10 per million tokens (it was $3/$15 in `RATES`, which overstated the
review and judge columns by half). Since 2026-09-30 the table is what `estimateBatch` in `src/lib/task-costs.ts`
prints: that file holds the token assumptions below and prices them through `costUsd` (`src/lib/usage.ts`), so a rate
change moves every row, and `tests/pricing-floor.test.ts` (rule 241) fails the build when a row crosses the ceiling in
section 4. Assumptions, stated so they can be argued with: 1,200 fresh input tokens and the 7,500-token cached
workspace block; 1,200 tokens of adaptive thinking; per-item output of 350 tokens (a post, an ad, a GBP entry, a cart
message), 900 (a plan, an OKR set, a script) or 2,500 (an article, a deck, a memo, a PRD) (`ITEM_SIZE`, exhaustive over
the 26 types). The reviewer and judge constants were fitted to reproduce the 2026-09-27 table within $0.001; they were
not measured. Replace them with the console's `byKind` averages after a month of real traffic (section 6).

**Hit** is a cache hit on the workspace block (an owner working in the app). **Cold** writes the block instead of
reading it, about $0.043 more per batch, which is what a cron run usually finds: the Sunday plan and each routine run
once a week or a month per brand. The floor test checks the cron-driven types (marked *cron*: `weekly_plan` and the
task type of every routine in `src/lib/routines.ts`) on the cold figure, and every other type on the hit figure
(founder decision, 2026-09-29). The checked figure is in bold. Majed's auto-run (section 5, since step 3b) starts
handoff items from the same 06:00 cron, so every type it may start is also checked on its cold figure (not bold in the
table, which bolds the hit a login's Run is checked on); `article` ($0.0918 cold) and
`followup_seq` ($0.0773) are over the ceiling cold, so the code never lets it start them (`autoBlock` answers `floor`,
`autoUnderFloor` in `src/lib/handoffs.ts`, rule 296) and they run only when a login presses Run, checked on the hit.

| Request | Items | Credits | Output tok | generate $ | review $ | judge $ | Total $ (hit) | $ per credit, hit | $ per credit, cold |
|---|---|---|---|---|---|---|---|---|---|
| `article` | 1 | 2 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | **0.0702** | 0.0918 |
| `followup_seq` | 7 | 4 | 7,500 | 0.197 | 0.041 | 0.028 | 0.266 | **0.0666** | 0.0773 |
| `weekly_plan` *cron* | 1 | 2 | 2,100 | 0.062 | 0.014 | 0.013 | 0.089 | 0.0446 | **0.0662** |
| `weekly_report` *cron* | 1 | 3 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | 0.0468 | **0.0612** |
| `cart_recovery` *cron* | 5 | 3 | 2,950 | 0.084 | 0.018 | 0.018 | 0.119 | 0.0398 | **0.0541** |
| `growth_experiments` | 5 | 4 | 5,700 | 0.152 | 0.032 | 0.023 | 0.207 | **0.0518** | 0.0626 |
| `unit_economics`, `decision_memo`, `feedback_synthesis`, `onboarding_flow` | 1 | 3 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | **0.0468** | 0.0612 |
| `cash_forecast` *cron* | 1 | 4 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | 0.0351 | **0.0459** |
| `lead_qualifier`, `dashboard_spec` | 1 | 2 | 2,100 | 0.062 | 0.014 | 0.013 | 0.089 | **0.0446** | 0.0662 |
| `strategy_review` *cron* | 1 | 5 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | 0.0281 | **0.0367** |
| `sales_script`, `retention_play` | 3 | 4 | 3,900 | 0.107 | 0.023 | 0.018 | 0.148 | **0.0371** | 0.0478 |
| `pricing_review`, `prd` | 1 | 4 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | **0.0351** | 0.0459 |
| `whatsapp`, `gbp` | 3 | 3 | 2,250 | 0.066 | 0.015 | 0.015 | 0.095 | **0.0318** | 0.0462 |
| `okrs` | 1 | 3 | 2,100 | 0.062 | 0.014 | 0.013 | 0.089 | **0.0297** | 0.0441 |
| `gtm_plan`, `board_deck` | 1 | 5 | 3,700 | 0.102 | 0.022 | 0.016 | 0.140 | **0.0281** | 0.0367 |
| `ads` | 5 | 5 | 2,950 | 0.084 | 0.018 | 0.018 | 0.119 | **0.0239** | 0.0325 |
| `roadmap` | 1 | 4 | 2,100 | 0.062 | 0.014 | 0.013 | 0.089 | **0.0223** | 0.0331 |
| `social` | 10 | 10 | 4,700 | 0.127 | 0.027 | 0.025 | 0.179 | **0.0179** | 0.0222 |

- **The watch list is `article` alone**: $0.0702 against the $0.0710 ceiling, 1.1% of headroom. The floor test pins
  the list of types above 95% of the ceiling, so a second type drifting close fails it before it crosses.
- **Repriced on 2026-09-30** because they crossed the ceiling: `weekly_plan` 1 → 2 credits (it was $0.0893 per credit
  on a hit), `followup_seq` 3 → 4 ($0.0888), and `weekly_report` 2 → 3 (the routine runs it cold: $0.0918). The floor
  test keeps the old prices as cases that must fail, so it cannot pass vacuously.
- **Chat drafts** (`draft_items`, social, whatsapp, ads and gbp only, checked in code: rule 250) charge the batch price
  pro rata and at least 1 credit, so 1, 2 or 3 items cost 1, 2 or 3 credits. On a cache hit two items cost $0.0418 per
  credit and three $0.0318. **One item costs $0.0716 for 1 credit, 0.9% over the ceiling**: the reviewer and the judge
  run on one short item almost as on a whole batch. It stays at 1 credit as a named exemption in the floor test
  (`ONE_ITEM_DRAFT_EXEMPTION`, founder decision 2026-09-29, reason written there), capped at today's $0.07165: if these
  drafts get dearer the test fails and the price or the exemption is decided again. Two- and three-item drafts are not
  exempt.

The cross-agent review (`xreview`, since 2026-09-30) adds one Sonnet call per reviewing agent to seven types, on top of
the table above. Worked out with the same assumptions plus these, all estimates: its system prompt is measured
(`crossReviewPrompt`: 6,104 characters for Razan, 4,952 for Majed, about 1,850 and 1,500 tokens, read from the cache after the
first call of the five minutes; 14 characters more than before step 3a was merged into step 3b, which added `<lead_brief>`
to its data tags, and 2 more since the Thakeen rename; `tests/cross-review.test.ts` checks these two numbers against the prompt it builds); its user message is the spec and brand file (about 550 tokens) plus the items as the
generation wrote them (2,500 tokens per long item, 900 per plan item), with an empty workspace; and it writes about 600
tokens of thinking and 80 to 150 per verdict. A cold cache adds about $0.004 per call; the owner's notes and workspace
files add their size as input, up to about 10,000 tokens (about $0.02) at the cap.

| Request | Reviewers | xreview $ | **Total $ with it** | **$ per credit** |
|---|---|---|---|---|
| `pricing_review` | Majed | 0.014 | **0.154** | **0.0385** |
| `decision_memo` | Razan | 0.014 | **0.154** | **0.0513** |
| `board_deck`, `strategy_review` | Razan | 0.014 | **0.154** | **0.0308** |
| `gtm_plan` | Razan and Majed | 0.028 | **0.168** | **0.0336** |
| `growth_experiments` | Razan | 0.021 | **0.228** | **0.0570** |
| `retention_play` | Razan | 0.015 | **0.163** | **0.0408** |

The real numbers are in the founder console under the `xreview` kind and, per agent, under Razan and Majed.

With this call every row stays under the section 4 ceiling ($0.07104 per credit), on a cold cache too (the cold
column above plus the call and its cold cache: `growth_experiments`, the closest, about $0.069). The floor test
(`tests/pricing-floor.test.ts`, rule 241, `estimateBatch`) does not count this call yet, so a change that makes the
review dearer is checked here by hand, not by the build.

The calls with no credit attached, or a fixed one:

| Request | Cost | Note |
|---|---|---|
| One chat message | **$0.02 – $0.14** | $0.02 per model call on Sonnet 5.5 ($0.05 on Opus until 2026-10-02); a turn that uses tools runs up to five, and its chat model calls never cost more than $0.14 together (`CHAT_TURN_MAX_USD`, checked in code before each call; $0.35 on Opus from 2026-10-01 to 2026-10-02; before any ceiling five calls of 8,000 output tokens could pass $1). A `generate_content` or `draft_items` tool call adds a whole batch on top, charged in credits; it is outside the ceiling. Included in the plan's monthly messages; past them, if the owner chose, billed after the reply its metered cost at the floor rate, at most the model's hold (2 credits on Sonnet 5.5, 4 on Opus 5; sections 4.1 and 4.2). A refused turn (`stop_reason: "refusal"`) is billed by Anthropic like any call and the owner is told it could not be completed (rule 467). What a typical message costs is not measured yet: the $0.02 is one call's arithmetic, not a measurement |
| One onboarding run | **≈ $0.57** (`onboardEstimateUsd`: 13,500 tokens in and 20,000 out on Opus, three calls between them) | free for the first brand; **9 credits** for each added brand, $0.64 at the ceiling, which the floor test checks covers the typical run. Each of the three parts retries once on failure (`src/lib/onboard.ts:127`), so a bad run can make up to six Opus calls, about twice the typical cost and up to roughly $1.8 when every part hits its `max_tokens`; 9 credits do not cover that case. Three runs per account per day |
Images and video are charged in credits too; their cost per model is in section 3.1.

## 3.1 Media renders

Written 2026-09-29. The credits are the catalogue's (`MEDIA_MODELS` in `src/lib/media-catalog.ts`, pinned by
`tests/media-catalog.test.ts`); our cost is the list price in `COST_USD` (`src/lib/media/config.ts`), taken from the
providers' published prices on 2026-09-29, and is what the founder console records for a render unless kie reports
`creditsConsumed` (then that × $0.005, `KIE_USD_PER_CREDIT`). The prompt adds at most about half a cent while Claude is on
(a Sonnet call capped at 400 output tokens, at $2/$10 per million) and nothing while it is paused. Vercel Blob storage
and transfer are extra, billed by Vercel and not metered per render or per tenant.

| Model | Provider | Credits | Our cost | $ per credit | kie credits expected (`EXPECTED_KIE_CREDITS`) |
|---|---|---|---|---|---|
| `img-fast` (Fast) | fal.ai | 1 | $0.003 | 0.003 | — |
| `img-balanced` (Balanced) | kie.ai | 1 | $0.04 | 0.040 | 8 |
| `img-premium` (Premium ad image) | kie.ai | 2 | $0.09 | 0.045 | 18 |
| `img-text` (English headline image) | kie.ai | 1 | $0.03 | 0.030 | 6 |
| `img-lifestyle` (Lifestyle photo) | Higgsfield | 1 | $0.0057 | 0.006 | — |
| `img-design` (Graphic design) | Higgsfield | 1 | $0.035 | 0.035 | — |
| `vid-quick` (Quick clip · 5s) | kie.ai | 12 | $0.21 | 0.018 | 42 |
| `vid-sound` (Clip with sound · 8s) | kie.ai | 12 | $0.30 | 0.025 | 60 |
| `vid-premium` (Premium · 10s with audio) | kie.ai | 24 | $1.00 | 0.042 | 200 |
| `vid-cinematic` (Cinematic · 5s) | Higgsfield | 12 | ~$0.70 (list $0.1407 per second) | 0.058 | — |
| `vid-motion` (Photo to motion · 6s) | Higgsfield | 12 | $0.28 | 0.023 | — |

- The target was at most about $0.05 per credit (founder decision F3). Every model but `vid-cinematic` meets it. Since
  2026-09-30 the floor test (rule 241) checks every row, with the prompt's $0.005 added, against the $0.0710 ceiling of
  section 4: `vid-cinematic` is the highest at $0.0588 per credit and passes with 17% of headroom.
- `vid-cinematic` is above the target at list price (spec R3), and Higgsfield prices change and promotions expire on
  2026-10-01. The console's "Check media providers" shows Higgsfield's own `/estimate` for it; if that exceeds $0.70, the
  choice is `resolution: "480p"` in `HF_MODELS` or a new price (founder question Q4). Until then it stays 12 credits at 720p.
- A kie render whose `creditsConsumed` exceeds 110 % of the expected credits (8.8, 19.8, 6.6, 46.2, 66, 220) switches its
  model off for 6 hours (section 5). `vid-sound` is the doubtful one: the Veo tier selector is the legacy
  `model: "veo3_fast"` (60 kie credits; Quality would be about 250), and kie's legacy record-info page does not document
  `creditsConsumed`, so the founder proves the tier with a balance difference before switching it on (spec 3.3, owner step 6).
- A failure the provider billed us for is `store_failed` (the result existed but could not be copied three times): its
  cost is recorded. A `timeout` is not counted, because we cannot know whether it was billed.

## 4. Where the margin actually is

Rewritten on 2026-09-30 for pricing phase 1. Revenue per credit comes from `PLAN_PRICE_SAR` and `PLAN_CREDITS` in
`src/lib/pricing.ts`, the single plan table, at 3.75 SAR to the dollar (`SAR_PER_USD`), on the list price excluding VAT
(`PRICES_INCLUDE_VAT` is false while the site says so):

| Plan | Price | Credits | Revenue per credit |
|---|---|---|---|
| starter | 299 SAR ($79.73) | 300 | **$0.2658** |
| pro | 499 SAR ($133.07) | 700 | **$0.1901** |
| business | 999 SAR ($266.40) | 1,500 | **$0.1776** |
| agency | the deal's price | the deal's credits | at least Business's **$0.1776**: `dealRespectsFloor` refuses a deal under 999 SAR, under 1,500 credits, or cheaper per credit than Business (integer check: price × 1,500 ≥ credits × 999). An Agency account without a valid deal is granted and counted as Business |

**The ceiling.** `MARGIN_FLOOR` is 0.6: at least 60% of the cheapest self-serve credit is margin, so what one credit
may cost us is at most 40% of $0.1776, **$0.07104** (`maxCostPerCreditUsd`). `tests/pricing-floor.test.ts` (rule 241)
holds every task type (section 3), every chat draft but the named exemption, the added-brand onboarding and every media
model (section 3.1) under it. A price cut or a larger allowance lowers the ceiling: Business at 899 SAR, or at 1,700
credits, puts `article` over and fails the build. If the accountant says prices must include VAT (`PRICES_INCLUDE_VAT`
true, 999 / 1.15), the ceiling falls to **$0.0618** and `article`, `followup_seq` and the cold `weekly_plan` fail: they
must be repriced before that switch.

Put the tables side by side and three things fall out.

1. **Output tokens are the whole bill.** Most of a batch's cost is Opus output at $25/M. Prompt caching saves about
   four cents a call at best; halving an output would save ten times that. The reviewer and the judge together add
   35–45% on top of the generation call, not the problem.
2. **The cheap-credit, long-output types were the hole.** Before 2026-09-30 `weekly_plan` cost $0.089 at 1 credit,
   `followup_seq` $0.266 at 3 credits, and the routine's cold `weekly_report` $0.184 at 2 credits: all three were over
   the ceiling, and the Sunday plan is the one type the cron creates on its own for every default brand. Phase 1 priced
   them at 2, 4 and 3 (`followup_seq` at 4, not 5: 4 already passes at $0.0666). `article` is the tightest type left.
3. **`social` is the best-priced thing in the product** at $0.018 per credit, a 10-to-15× markup depending on plan.
   The pricing is not wrong on average; the spread per type is still about 4×.

The next moves, cheapest first: cap `max_tokens` per type instead of a flat 16,000, and move the judge to a sampled run
(every third batch) rather than every batch. Either would give `article` and the one-item draft room again.

## 4.1 Chat allowance against revenue

Written 2026-10-01 for pricing phase 2; rewritten on 2026-10-02 when chat moved from Opus 5 to Sonnet 5.5 (`CHAT_MODEL`, founder decision) and the ceiling fell from $0.35 to $0.14. Net revenue is `creditRevenueUsd(plan) × PLAN_CREDITS[plan]` from `src/lib/pricing.ts`, which is the list price ÷ 3.75 (VAT excluded, section 4). The cost of a message is an assumption, not a measurement: $0.02 is one Sonnet 5.5 call (section 3's "$0.05 per model call" on Opus ÷ 2.5), $0.032 the spec's estimate for a Sonnet turn (spec section 5), and $0.14 the ceiling no message can pass in code (`CHAT_TURN_MAX_USD`). What a typical message costs has not been measured yet, so no copy states one. Each row assumes every message of the allowance is used; the percentage is of the plan's net revenue, before what the credits themselves cost.

| Plan | Messages (`CHAT_ALLOWANCE`) | Net revenue | At $0.02 a message | At $0.032 a message | Every message at the $0.14 ceiling |
|---|---|---|---|---|---|
| trial | 30, once for the trial | $0 | $0.60 | $0.96 | $4.20 |
| starter | 250 a month | $79.73 | $5.00 (6%) | $8.00 (10%) | **$35.00 (44%)** |
| pro | 650 a month | $133.07 | $13.00 (10%) | $20.80 (16%) | **$91.00 (68%)** |
| business | 1,300 a month | $266.40 | $26.00 (10%) | $41.60 (16%) | **$182.00 (68%)** |

Agency gets Business's 1,300 unless the founder sets an override (`User.chatAllowance`), against the deal's price.

- **At the ceiling chat alone no longer costs more than the plan earns, but chat and credits together still can.** On Opus under $0.35 (until 2026-10-02) the last column was $87.50 / $227.50 / $455.00, 110% / 171% / 171% of revenue. Under $0.14 it is 44% / 68% / 68%. Add every credit at its dearest ($0.0716: $21.48 / $50.12 / $107.40) and an account that does both costs $56.48 (71%) on Starter, $141.12 (106%) on Pro and $289.40 (109%) on Business. The ceiling bounds one runaway turn; it is not a typical cost, and only abuse reaches it on every message (long, tool-heavy turns written to fill each reply). The burst limit (30 an hour and 150 a day on a paid plan since 2026-10-01) slows that down but does not stop it within a month: the monthly allowance remains the real monthly ceiling.
- **Same work per message.** Every Sonnet 5.5 rate in `RATES` is Opus 5's ÷ 2.5, and so is the ceiling, so a message gets exactly the output tokens it had before (`tests/chat-allowance.test.ts` pins it), and `chatOverflowHold()` falls from 5 credits to 2.
- **Not measured, not evaluated.** The spec made the switch wait for the golden eval and a Gulf-dialect chat check; the founder moved chat on 2026-10-02 without them. Quality is watched through the thumbs and the console's chat column; the Opus figures above are the way back (`CHAT_MODEL` and `CHAT_TURN_MAX_USD` together, never one without the other).
- **Where it shows.** The founder console's per-account margin column (users tab, `marginPct`: the price against this month's model cost, chat included; red under 50%), and since 2026-10-01 the Chat column, whose tooltip gives the account's chat cost this month and per message (`usdPerMsg`, `chatUsdPerMessage` in `src/lib/admin-stats.ts`: the cost over every message sent, the raw count `ChatStatus.counted` plus the messages continued on credits, so an allowance lowered mid-month does not inflate it), and the credits the messages on credits were billed (`chatCredits`). A trial's cost per message reads low when the trial spans two months: the cost is this month's, the count the trial's.
- **The spec's numbers now hold.** Spec section 5's margins counted chat at about $0.032 a message ($8.00 / $20.80 / $41.60 for full allowances), the fourth column above. On Opus at $0.08 the same allowances cost $20.00 / $52.00 / $104.00.
- **Messages continued on credits keep the floor.** The hold and the ceiling are per model (`chatHoldFor(model)` and `chatTurnMaxUsd(model)`, section 4.2): 2 credits and $0.14 on the default chat model Sonnet 5.5, 4 credits and $0.28 on Opus 5; the figures below are Sonnet 5.5's. Nothing is taken before such a message: the gate only checks the balance is at least the model's hold (`chatOverflowHold()`, 2 credits since 2026-10-02; 5 under the old $0.35 Opus ceiling), so the message's own tools (a batch it asks for) can spend the whole balance. After the reply it is billed its metered cost at $0.07104 a credit, so it keeps at least 60% margin on Business's credit (73% on Starter's, 63% on Pro's). The bill is at most the hold, 2 credits ($0.142 at that rate; 4 credits, $0.284, on Opus 5), which covers the model's ceiling, so no message's model cost goes beyond what it can be billed; the remainder under one credit waits on the account (`User.chatCarryMicro`) for the next one. The one leak: a message whose tools emptied the balance is billed only what is left, and the rest of its cost (at most its model's ceiling) is not billed; the next message is then refused until the balance holds the hold again. A failed message is not billed.

## 4.2 Credits by model tier (2026-10-08)

Spec `docs/superpowers/specs/2026-10-08-straitly-model-routing-design.md` section 6, plan Task 4. Files:
`src/lib/models/tiers.ts` (`TIER_MULTIPLIER`, `PRICED_AT`, import-free), `src/lib/models/credits.ts` (`tierMultiplier`,
`creditsFor`, `chatTurnMaxUsd`, `chatHoldFor`, `chatUnitsFor`, server only), `src/lib/task-costs.ts` (`estimateFor`), the `tasks`
allow-lists in `src/lib/models/catalog.ts`. Tests: `tests/model-credits.test.ts` and the "rule 241 by tier" and
"rule 313 by tier" blocks of `tests/pricing-floor.test.ts`. No caller picks a model yet (plan Tasks 5 and 6), so every
figure the product charges today is unchanged.

A task or a chat message costs its base credits times its model's tier multiplier **relative to the surface's default
model** (`PRICED_AT`), rounded up, at least 1. The default model of each surface is x1, so today's prices hold:

| Surface (default) | Opus 5 (premium) | Sonnet 5 / 5.5 (standard) | an economy model |
|---|---|---|---|
| generate (`claude-opus-5`) | x1 | x0.5 | x0.3 |
| chat (`claude-sonnet-5-5`) | x2 | x1 | x0.6 |

**The floor over the catalog (rule 241 by tier).** For every catalog model with `auto` or `pick` and every task type it
allows, `estimateFor(type, model)` (one batch on a COLD cache, the dearest case, at the model's catalog rate; the reviewer
and the judge stay on Sonnet 5) divided by the credits it is CHARGED (`creditsFor(TASK_COST[type], model, "generate")`)
must stay at or under $0.07104. Figures on 2026-10-08, per charged credit:

| Model | Over the ceiling cold | Closest under | What was done |
|---|---|---|---|
| `claude-opus-5` (x1) | `article` $0.0918, `followup_seq` $0.0774 | `weekly_plan`, `lead_qualifier`, `dashboard_spec` $0.0662 | Named exemption in the test: these two are today's prices, checked on a hit since 2026-09-29 (article $0.0702, followup_seq $0.0666) and kept off Majed's auto-run (rule 296). Pinned at today's cold figures |
| `claude-sonnet-5`, `claude-sonnet-5-5` (x0.5) | `article` $0.0964 (1 credit), `followup_seq` $0.0826 (2 credits); on a hit still $0.0791 and $0.0740 | `weekly_plan`, `lead_qualifier`, `dashboard_spec` $0.0692 at 1 credit (97% of the ceiling) | Both types left out of the two entries' `tasks`; `generateBatch` refuses them on these models before charging |

The default model's two cold exemptions (Opus 5 on `article` $0.0918 and `followup_seq` $0.0774, cold) exist on purpose,
are pinned by name in `tests/pricing-floor.test.ts` (`DEFAULT_MODEL_COLD_EXEMPTION`, so any other model or type over the
ceiling fails the build), and were ratified by the coordinator on 2026-10-08. The test covers exactly the entries
with `auto` or `pick`, and only those can be charged: `generateBatch` and `reserveChatTurn` refuse any other catalog
entry (`model_not_offered`) before anything is charged or counted, and chat also refuses one without tools
(`model_not_chat`).

Why the Sonnets miss on these two although their generation call is 2.5 times cheaper: the charge halves, but the
reviewer and the judge cost the same whatever generated, and a 2-credit article rounds to 1 credit. Chat drafts
(`draft_items`, 1-3 items) on a Sonnet keep the floor cold at every size (the dearest, a 2-item draft at 1 credit, about
$0.0665); on Opus they keep the one-item exemption of section 4. An economy model (none in the catalog yet) at x0.3 is far
under on every type with these token assumptions; it is checked the day it is added.

**Chat by tier (rule 313 by tier).** A message's ceiling is `chatTurnMaxUsd(model)` = $0.14 x its chat multiplier, and
the overflow hold is the ceiling at the floor rate, rounded up:

| Chat model | Ceiling per message | Overflow hold |
|---|---|---|
| Sonnet 5.5, Sonnet 5 (x1) | $0.14 | 2 credits |
| Opus 5 (x2) | $0.28 | 4 credits |
| an economy model (x0.6) | $0.084 | 2 credits |

**How a message on a dearer model counts against the allowance (coordinator ruling 2026-10-08, option a).** A message
counts `chatUnitsFor(model)` = ceil(its chat multiplier) messages of the allowance: 1 on Sonnet 5.5 and Sonnet 5 (as
today), 2 on Opus 5, 1 on an economy model. Its ceiling stays its own (`chatTurnMaxUsd`), so each unit carries at most
$0.14, the ceiling the allowances were priced at in section 4.1, whatever the owner picks:

| Chat model | Units per message | Ceiling per unit | Full allowance at the ceiling, Starter / Pro / Business |
|---|---|---|---|
| Sonnet 5.5, Sonnet 5 | 1 | $0.14 | $35.00 (44%) / $91.00 (68%) / $182.00 (68%) |
| Opus 5 | 2 | $0.14 | the same: 125 / 325 / 650 Opus messages, $35.00 / $91.00 / $182.00 |
| an economy model | 1 | $0.084 | $21.00 (26%) / $54.60 (41%) / $109.20 (41%) |

Counted at 1 per message, Opus 5 would have cost a full allowance $70.00 (88% of $79.73 net), $182.00 (137% of $133.07)
and $364.00 (137% of $266.40); the "rule 313 by tier" block of `tests/pricing-floor.test.ts` pins both rows of
percentages. The units are computed once per turn in `reserveChatTurn` and carried on the gate (`units`), so the reserve,
the give-back of a failed turn and the overflow counter all move by the same number; a message whose units would pass
what is left of the allowance is refused before any model call (or, with "continue on credits" on, goes wholly on
credits, needing that model's hold: 4 credits on Opus 5). A multiplier that is not a finite number above 0 throws
`chat_allowance_unpriced` before anything is counted. What the owner and the founder console read as "messages" (used,
left, the console's cost per message) are these units from then on; the copy that explains that an Opus message counts
2 belongs to the model picker (plan Task 6). No caller passes a chat model yet, so every account still counts 1.

## 5. What bounds the spend today

- **Credits** bound generation: `charge` runs before the model call, `refund` on failure (`src/lib/credits.ts`).
- **Per-agent monthly caps** (since 2026-09-29), set by the owner per brand on the Governance page, bound what one
  agent can spend in a UTC month: every charging path passes the owning agent and its cap to `charge`, which refuses
  over the cap before the balance moves or a model is called. They bound batches, drafts, images and videos (media renders
  are charged in `startMedia` with the item's owning agent and its cap); chat messages are not any agent's work and never
  count against a cap (a message past the allowance is billed by `settleChatOverflow`, not through `charge`, so no cap
  reads it), so chat is bounded by its own allowance and ceiling below.
- **Chat** (since 2026-10-01, pricing phase 2) is bounded in code in four ways, on the web route and on MCP `ask_noor`
  alike; the allowance and the burst limit are checked before the owner's message is saved, the other two before each
  model call. An ended trial (`trialOver`) gets no turn at all, before any of them (402 `trial_over`, rule 330), so it
  uses up neither the burst limit nor a message of the trial's allowance:
  - the plan's monthly allowance (`CHAT_ALLOWANCE` in `src/lib/pricing.ts`: trial 30 for the whole trial, 250 / 650 /
    1,300 a month), counted per account with INCRBY before the turn (`reserveChatTurn`, `src/lib/chat-allowance.ts`) and
    given back when the turn fails or costs nothing; when it is used up chat pauses (402 `chat_allowance`) until the 1st
    (UTC), unless the owner of a paid plan turned "continue on credits" on, and then each message is paid for (section
    4.1: it needs at least its model's hold in the balance, 2 credits on Sonnet 5.5 and 4 on Opus 5, nothing is taken
    before it, and after the reply it is billed its metered cost at the floor rate, at most that hold; 402
    `chat_credits` below it);
  - the per-message ceiling: the turn's chat model calls never cost more than $0.14 (`CHAT_TURN_MAX_USD`, $0.35 on Opus until 2026-10-02), because
    each call's `max_tokens` is what is left of it after the turn's cost so far and an upper estimate of the call's
    input (`nextMaxTokens`, `src/lib/chat-budget.ts`), and no call is made with less than 2,048 tokens left
    (`CHAT_MIN_OUT`). The estimate counts 3 characters a token (`CHARS_PER_TOKEN_EST`). The first call prices the cached
    prefix (the tools and system blocks 1-2) as a cache write and the rest as input; every later call prices the
    previous call's cache read and cache write tokens as a cache read, and the rest of its input, its output and the
    tool results added since as input. A call the model ended at `max_tokens` is never acted on: its tool calls do not
    run, and its text is kept with a note that it was cut off;
  - the history guard: the model gets the newest 16 messages within 24,000 characters, each cut to 6,000
    (`trimHistory`; a thread that starts with the first-run onboarding's assistant messages is kept as it is), so a
    long thread cannot make every message dearer; then the oldest are dropped until the first call has at least 4,000
    output tokens (`CHAT_FIRST_MIN_OUT`, `fitFirstCall`), so a full workspace shortens the thread's memory rather than
    the answer. When even the newest message alone leaves less than 2,048, no call is made, the reply says the
    workspace is too large for one message, and the message is not counted;
  - the burst limit: `chatCaps(u)` in `src/lib/rate.ts` per account, by plan (`CHAT_CAPS`): 30 an hour and 150 a day
    on a paid plan (Agency included), 10 an hour and 30 a day on a trial (429 with `retry` "hour" or "day",
    `chatRefusal`, rule 331), checked first, so a burst never touches the month's count. Founder decision 2026-10-01:
    lowered from 40 an hour and 200 a day on every plan until the Sonnet chat eval passes (chat moved to Sonnet 5.5
    on 2026-10-02 without that eval, and the limit was left as it is). At the ceiling, one paid account's worst day is
    150 turns × $0.14 = $21.00 of chat (it was 150 × $0.35 = $52.50 on Opus, 200 × $0.35 = $70.00 before 2026-10-01). The burst limit only paces
    the month: the monthly allowance remains the real monthly ceiling (Starter's 250 messages are under two such days).
    A trial's day of 30 equals its 30 messages for the whole trial, so it never binds before the allowance does (at most
    30 × $0.14 = $4.20 of chat per trial account; $10.50 on Opus); the 10 an hour paces a trial. Before 2026-09-20 nothing bounded
    chat; from then until 2026-10-01 this limit was the only bound.
- **Onboarding** is free for the first brand and 9 credits for each added brand built from its URL (since 2026-09-30,
  rule 246; the manual brand form makes no model call and is free): the charge goes to Noor in that brand's scope under
  her monthly cap there, after every other refusal and under the run's lock (330 s, owner-token release, so two runs
  never build on one charge), before the stream. It is held on the account record (`User.onboardPaid[scope]`) in the same
  save as the debit: a retry or a revisit reuses it instead of paying twice, a build that fails before the brand is
  saved refunds it and drops the hold in one save (once), and the daily cron refunds a hold no run used for a day, so a
  run the platform killed is never charged twice and never kept without a brand. A failure after the brand was saved is
  not refunded (the brand is delivered and a rerun answers 409). Once per workspace, three runs per
  account per day, so an agency sets up at most three brands a day, and signup is five per IP per hour. The worst case
  an attacker can drive from one address through free first brands is therefore still about $9 an hour; an added
  brand's run is paid for.
- **Brands** are unlimited on every plan (since 2026-09-30, rule 245). What bounds them is a creation rate, not a count:
  10 an hour and 30 a day per account (`brandAddRefusal` in `src/lib/rate.ts`, which says which window refused), plus
  the 9-credit setup and the daily
  onboarding allowance above. Every brand fans out into every cron, which is why an added brand's Sunday plan starts off.
- **Cron** charges `TASK_COST.weekly_plan` (2 credits since 2026-09-30) for the Sunday plan and makes no model call for
  the daily brief. The Sunday plan is on by default only for the default brand; an added brand's is off until the owner
  switches it on in Scheduled tasks (`getSchedule` in `src/lib/schedule.ts`, rule 247). Added brands created before
  2026-09-30 stored the old default (on) in `schedule:{scope}`; on an added brand a stored `weeklyPlan` counts only with
  the `weeklyPlanSetAt` stamp the owner's switch writes, so those brands start off too and are not charged.
- **The cross-agent review** (since 2026-09-30) makes no call of its own: it runs inside a paid batch of one of seven
  types, one call per reviewing agent (two for `gtm_plan`), so the credits and caps that bound batches bound it too.
  The owner can switch it off on the Governance page (`Governance.crossReview`); golden runs never make it. Each call
  is one attempt of at most 45 s (`CROSS_REVIEW_TIMEOUT_MS`, `maxRetries: 0`), and none starts with less than 60 s of
  the caller's deadline left (`CROSS_REVIEW_MIN_MS`), so a slow reviewer can never push a charged batch past the
  platform's 300 s limit, where the credits would be kept and nothing saved; the batch is then saved without notes.
- **Majed's handoffs** (since 2026-09-30) add no model call of their own. Proposing is a tool call inside a chat turn
  (free, bounded like chat) and writes a record; each item runs only when a login presses Run (or, opt-in, from Majed's
  auto-run below), as one batch through
  `generateBatch` (charged `TASK_COST[type]` to the item's owning agent under its cap, refunded on failure), one item per
  request, at most `HANDOFF_RUNS_PER_HOUR` (60) runs per account an hour, under a lock that lets one run of a handoff at a
  time. The brief block adds about 900 characters to that batch's generation, reviewer, cross-review and judge messages:
  the brief (at most 600 characters, JSON-quoted by `asData`, so a little more when it holds characters that must be
  escaped), its label (`LEAD_BRIEF_LABEL`, 259 characters) and the tags around it (about 30). At a full brief that is
  889 characters, about 270 input tokens on each call: about $0.0024 per batch (Opus for the generation, Sonnet for the
  reviewer and the judge) and $0.0030 with one cross-review call. `estimateBatch` does not count it, so the floor test
  (rule 241) does not either. It matters for one type: a handed-off `article` that a login runs on a cache hit costs
  about $0.0714 per credit with a full brief, 0.6% over the $0.07104 ceiling (a shorter brief costs less). That is not
  checked by the build and needs a founder decision, a price or a named exemption like the one-item drafts'; Majed's
  auto-run never starts an article (rule 296).
- **Media renders** (spec 4.8, `src/lib/media/jobs.ts`) are bounded in several layers, all but the last in code:
  - credits are charged before the submit and refunded exactly once when the render fails (`refundOnce`: a 60 s claim on
    `mrefund:{jobId}`, then `"done"` once the refund was made), so an owner never pays for a failure, and the chat tool
    can render only the 1-credit default model (it has no `model` argument) and starts none with less than a minute of
    the chat request left (`CHAT_RENDER_MIN_MS` in `src/lib/chat.ts`);
  - per account: images 30 an hour and 150 a day, videos 6 an hour and 20 a day (`RENDER_LIMITS`), counted only for
    requests that got past the balance pre-check and the flight lock;
  - trial accounts: one kept video per trial, from the 12-credit models only (`TRIAL_VIDEO_MODELS`, `mtrialvid:{email}`;
    founder question Q1), because one free signup could otherwise spend $2-4 of real money on video;
  - kie.ai creates: 18 per 10 s for every tenant together (`KIE_CREATES`); Higgsfield: 2 live jobs in all
    (`HF_MAX_OPEN`), 1 per account, at most 1 of them a video. The per-account and kie windows are `allow()` counters
    whose expiry is set with EXPIRE NX on every hit (`src/lib/rate.ts`), so a window always ends: before 2026-09-29 one
    failed expiry call could leave `rate:kie:create` refusing every tenant for good;
  - one render per task and kind at a time (`mflight`), so a double click charges once;
  - the owner's monthly cap for the agent that owns the item (see per-agent caps above), checked against the session's
    count before anything moves and again inside the ledger lock at the charge (402 `agent_cap`, nothing charged);
  - only models the founder listed in `MEDIA_MODELS_ON` are offered (the owner steps list a model only after its line in
    the console check is green);
  - the breaker (`trip`, `setOff`): 3 `store_failed`, `timeout` or defect-class submit failures of one model within an
    hour switch it off for 6 hours; an overbilled kie render (above 110 % of its expected credits) switches its model off
    for 6 hours; an empty provider balance (`no_balance`) switches all of that provider's models off for 1 hour;
  - at the providers: the kie key's hourly, daily and total credit caps, and Higgsfield's auto top-up off or capped
    (owner steps in `docs/Owner_Tasks_AR.md`, section ج2).
  The losses the design accepts are a render the provider billed but we could not keep (`store_failed`) and a submit that
  timed out ambiguously and rendered anyway after the refund (spec R9); the breaker bounds the first, the limits and the
  kie caps the second.
- **Routines** (since 2026-09-29) are opt-in per brand and charge like a batch the owner asked for: `TASK_COST` of the
  type (Dana's weekly report 3 since 2026-09-30, Noor's cart recovery 3, Razan's cash forecast 4, Majed's strategy review 5), one
  generation plus the reviewer and the judge per run, at most once per UTC week or month. Every run passes the owning
  agent and its monthly cap to `charge`, and the weekly cap on scheduled items counts the whole batch before charging,
  including the batches of the brand's other routines running at the same moment (`routinehold:`). A gate checked in
  code skips a run without the input it needs ("idle" or "no_data", no charge, no model call; the next day's cron asks
  again), no run is charged while Claude is paused or without a key, and a failed generation is refunded. No run is
  started with less than 180 s of the cron's invocation left (`retry:late`, before the charge; a later hop runs it),
  and the cross-agent review of Majed's strategy review is bounded by that deadline, so a kill is left to a model call
  far slower than usual. A run the platform kills after the charge is not refunded, so each routine may leave at most
  two such charges per week or month (`routinetry:`) before it waits for its next period. The worst case for one brand with all four on is 3 + 3 per
  week and 4 + 5 per month in credits, plus at most two lost charges per routine and period when runs are killed.
- **Reports reprice past work.** The profile, the owner's Reports page and the founder overview count credits used as
  items × today's per-item price, `TASK_COST / TASK_COUNT` (`src/app/api/profile/route.ts`, `src/lib/stats.ts`, `src/lib/admin-stats.ts`), so in the
  month of a price change the earlier weekly plans, weekly reports and follow-up sequences are counted at 2, 3 and 4.
  The 9-credit onboarding charge is not a task and is in no "credits used" total; it shows in the balance and in Noor's
  monthly spend for that brand (`agentSpend`). Storing the credits charged on each task is left for a later phase.
  Renders are the exception: every reader counts what they really charged, `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)`
  (an image 1 or 2 by model, a video 12 or 24); since 2026-09-30 the profile does too (`mediaCredits`), and its usage
  row shows the catalogue's image and video ranges instead of a flat 1.
- **Majed's auto-run** (since 2026-09-30, `src/lib/handoff-auto.ts`) is the only spend on a handoff without a login
  pressing Run, and it is off until the owner switches it on in Governance, which needs a monthly cap on at least one
  agent Majed hands work to and an explicit confirmation. The routines cron then starts at most one item a day per
  brand, of a proposal the owner made in chat in the last 7 days whose card reached the owner (the reply carrying it
  was saved, and its conversation was not deleted; the Governance page lists what may start next, with Decline), of at most 3 items and 12 credits in all, only for
  an agent with an owner-set cap, and only for a type that keeps the 60% margin floor on the cold cache this cron usually
  finds (`autoUnderFloor`, rule 296: never `article` or `followup_seq` today; the dearest it may start, with the
  cross-agent review and a full brief, is `growth_experiments` at about $0.0696 per credit): each item is one batch charged `TASK_COST[type]` to that agent under that cap (so the
  owner's cap is the bound on what the auto-run can spend on an agent in a month), inside the weekly cap on items made
  on their own (`isAutonomous`, shared with the Sunday plan and the routines). Today's dearest item a 12-credit proposal
  can hold is `social` at 10 credits, so one brand's auto-run spends at most 10 credits a day, within those caps. It
  never runs while Claude is paused or without a key, a refused charge costs nothing, a failed generation is refunded,
  and a run the platform kills after the charge is not started again (at most two such charges per item,
  `handofftry:`). Its batches wait for the owner like any other (`forcePending`), so nothing it makes is published or
  approved on its own.

## 6. Where the real numbers live

`meter()` (`src/lib/usage.ts`) records every call under `usage:{email}:{YYYY-MM}` — tokens in and out, call count,
cost in micro-dollars, and since 2026-09-20 the same three numbers **per kind of call**. So the founder console shows,
per account:

- **Users tab:** tokens, cost this month, and a **margin** column (`priceOf`: the plan's list price, or an Agency
  account's deal price, against model cost; red under 50%). Since 2026-09-30 the rows also carry the deal and the
  monthly allowance (`allowanceOf`). Since 2026-10-01 a Chat column: the raw count against the allowance (`chatUsed`
  is `ChatStatus.counted`, the trial's count for a trial, so it can pass an allowance lowered mid-period; red once it
  reaches the allowance or 10% or less is left), the founder override, "+N on credits (M credits)" for the messages
  continued on credits this month and the credits they were billed (`chatCredits`, the month's `chat_cred` counter),
  and in its tooltip this month's chat cost (`byKind.chat`) and the cost per message (`usdPerMsg`,
  `chatUsdPerMessage`: chat cost ÷ (`counted` + messages on credits), null when none was sent).
- **User detail** (chat): the account's `ChatStatus` (with `counted` and `overflow.credits`) and `chatUsdPerMsg`, the
  same cost per message as the list.
- **User detail:** a cost-per-request-type table — calls, average cost of one call of that kind, total, tokens — and,
  since 2026-09-29, a cost-per-agent table (calls, average, total) from `usage:{email}:{YYYY-MM}:agent:{id}:*`.
  Generation, the reviewer and the judge count for the agent that owns the task type, a chat turn for the agent in
  the chat, an image prompt for the owner of the item, onboarding for Noor.

That makes section 3 checkable: compare the estimate against `byKind.generate.usd / byKind.generate.calls` for a real
account and correct the assumptions here.

Render spend (since 2026-09-29, spec 4.9) is recorded separately from model usage, and globally only (never per email,
so nothing outlives `wipeAccount`):

- At every terminal transition `recordOutcome` (`src/lib/media/jobs.ts`) increments, for the job's model and month,
  `render:_all:{YYYY-MM}:m:{model}:jobs` (done) or `:failed`, `:credits` (credits kept, done only) and `:usd_micro` (done and
  `store_failed`: the provider billed us; `timeout` is not counted), plus `render:_all:{YYYY-MM}:kie_centicredits` when kie
  reported `creditsConsumed`. Every amount is an integer (`Math.round` before `incrby`): Upstash rejects
  175000.00000000003 while the memory store accepts it. It also pushes `{id, model, state, error, providerCredits, costUsd,
  at}` to `mjobs:recent` (capped at 50, no email, scope or prompt).
- `renderSpend(month = monthKey())` (`src/lib/admin-stats.ts`) reads the four counters of all 11 models and
  `kie_centicredits` in one `Promise.all` and derives `{usd, kieCredits, byProvider, byModel}` in code (sums stay in
  micro-dollars and are divided once).
- `overview()` fetches it next to `getUsage("_all")`. `Overview.revenue` gains `renderCostUsd`, `renderByProvider` and
  `renderByModel`; the gross margin is `(MRR − (model USD + render USD) × 3.75) / MRR`, since a video can cost more than a
  month of text for the same account; "credits used this month" counts `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)` per
  item, so a 12- or 24-credit clip is counted as charged.
- **Billing tab:** a "Render cost this month $" tile beside model cost; a "Per model" table (model, done, failed, credits
  kept, USD, $ per credit = USD / credits kept); one line per provider; and "Check media providers"
  (`GET /api/admin/media`): configured flags, the Blob probe, the models switched on and offered, the kie balance and the
  kie credits used this month, Higgsfield's estimate per model, the open jobs per provider, the switched-off models with
  their reason and end time, and the last 50 renders.
- **Owner reports** (`src/lib/stats.ts`): `Kpis.videos` counts items with a clip, `creditsUsed` counts `mediaCredits` the
  same way as the founder overview, the Reports page offers a "Videos generated" tile, and `statsText` (what Dana reads)
  says "images generated: N; videos generated: M".

Compare the per-model USD against section 3.1 after the first week of spend, and correct `COST_USD` and the table there.
