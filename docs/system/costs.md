# What a request costs, and where the money goes

Written 2026-09-20; sections 1, 3, 3.1, 4 and 5 updated on 2026-09-30 for pricing phase 1 (`src/lib/pricing.ts`, `src/lib/task-costs.ts`). Every number in the tables is arithmetic over two inputs: the list prices in `src/lib/usage.ts`
(`RATES`) and the prompt sizes the code actually builds. Nothing here is a guess about Anthropic's billing; the guesses
are only in the *output* token counts, and those are marked as such. Real per-account numbers are metered and shown in
the founder console — see "Where the real numbers live" at the end.

## 1. The model calls the product makes

| Call | Model | Where | Charged to the customer |
|---|---|---|---|
| `generate` | `claude-opus-5`, `max_tokens` 16000, effort medium | `src/lib/noor.ts` `generate` | credits, per `TASK_COST` |
| `review` | `claude-sonnet-5`, 16000, effort low | `noor.ts` `critique`, runs after every batch unless governance turns it off | free (inside the batch) |
| `judge` | `claude-sonnet-5`, 8000, effort low | `src/lib/judge.ts`, runs after the response via `after()` | free |
| `chat` | `claude-opus-5`, 8000, effort medium, **up to 5 calls per turn** (tool loop) | `src/lib/chat.ts` | **nothing** |
| `onboard` | `claude-opus-5` × 3 parallel, 10000 + 12000 + 12000 | `src/lib/onboard.ts` | **nothing** for the first brand (the default scope); **9 credits** for each added brand since 2026-09-30 (`ONBOARD_EXTRA_BRAND_COST`, `src/lib/pricing.ts`), charged to Noor in that brand's scope before the stream and refunded when the brand is not saved; once per workspace |
| `image_prompt` | `claude-sonnet-5`, 400, effort low, one attempt of at most 20 s, no SDK retries | `src/lib/media/prompts.ts` (image **and** video prompts; video is metered under this kind too, spec A18) | charged with the render (section 3.1); a fixed template, and no model call, while Claude is paused |

## 2. Prompt size, measured

`systemPrompt` (`noor.ts`) builds three blocks. The first two carry `cache_control`, the third never can (it holds
today's date, the live calendar, the owner's preferences and, since 2026-09-29, the recent feedback on the agent's own
work from `feedbackFor`, all of which move).

| Block | Characters | Cacheable |
|---|---|---|
| fixed (rules + the agent's playbook from `content/skills/`) | 10,374 (Razan) – 16,657 (Majed) | yes |
| workspace (brand file + up to 5 × 6,000 chars of memory files) | 1,500 with an empty workspace, 31,500 at the cap | yes |
| today (date, seasons, up to 30 preferences, recent feedback) | 500 – 8,800 (the feedback block is at most about 2,300 characters: counts, 5 notes of 200, 3 judge flags of 120; absent when there is none or learning is off) | no |

At roughly 3.3 characters per token for this Arabic/English mix, a full batch prompt is **≈ 8,700 input tokens**: about
7,500 of them cacheable and about 1,200 fresh every time.

## 3. Cost of one batch

Recomputed on 2026-09-27 for Sonnet 5 at $2/$10 per million tokens (it was $3/$15 in `RATES`, which overstated the
review and judge columns by half). Since 2026-09-30 the table is what `estimateBatch` in `src/lib/task-costs.ts`
prints: that file holds the token assumptions below and prices them through `costUsd` (`src/lib/usage.ts`), so a rate
change moves every row, and `tests/pricing-floor.test.ts` (rule 221) fails the build when a row crosses the ceiling in
section 4. Assumptions, stated so they can be argued with: 1,200 fresh input tokens and the 7,500-token cached
workspace block; 1,200 tokens of adaptive thinking; per-item output of 350 tokens (a post, an ad, a GBP entry, a cart
message), 900 (a plan, an OKR set, a script) or 2,500 (an article, a deck, a memo, a PRD) (`ITEM_SIZE`, exhaustive over
the 26 types). The reviewer and judge constants were fitted to reproduce the 2026-09-27 table within $0.001; they were
not measured. Replace them with the console's `byKind` averages after a month of real traffic (section 6).

**Hit** is a cache hit on the workspace block (an owner working in the app). **Cold** writes the block instead of
reading it, about $0.043 more per batch, which is what a cron run usually finds: the Sunday plan and each routine run
once a week or a month per brand. The floor test checks the cron-driven types (marked *cron*: `weekly_plan` and the
task type of every routine in `src/lib/routines.ts`) on the cold figure, and every other type on the hit figure
(founder decision, 2026-09-29). The checked figure is in bold.

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
- **Chat drafts** (`draft_items`, social, whatsapp, ads and gbp only, checked in code: rule 230) charge the batch price
  pro rata and at least 1 credit, so 1, 2 or 3 items cost 1, 2 or 3 credits. On a cache hit two items cost $0.0418 per
  credit and three $0.0318. **One item costs $0.0716 for 1 credit, 0.9% over the ceiling**: the reviewer and the judge
  run on one short item almost as on a whole batch. It stays at 1 credit as a named exemption in the floor test
  (`ONE_ITEM_DRAFT_EXEMPTION`, founder decision 2026-09-29, reason written there), capped at today's $0.07165: if these
  drafts get dearer the test fails and the price or the exemption is decided again. Two- and three-item drafts are not
  exempt.

The calls with no credit attached, or a fixed one:

| Request | Cost | Note |
|---|---|---|
| One chat message | **$0.05 – $0.26** | $0.05 per model call; a turn that uses tools runs up to five, and a `generate_content` tool call adds a whole batch on top |
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
  2026-09-30 the floor test (rule 221) checks every row, with the prompt's $0.005 added, against the $0.0710 ceiling of
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
may cost us is at most 40% of $0.1776, **$0.07104** (`maxCostPerCreditUsd`). `tests/pricing-floor.test.ts` (rule 221)
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

## 5. What bounds the spend today

- **Credits** bound generation: `charge` runs before the model call, `refund` on failure (`src/lib/credits.ts`).
- **Per-agent monthly caps** (since 2026-09-29), set by the owner per brand on the Governance page, bound what one
  agent can spend in a UTC month: every charging path passes the owning agent and its cap to `charge`, which refuses
  over the cap before the balance moves or a model is called. They bound batches, drafts, images and videos (media renders
  are charged in `startMedia` with the item's owning agent and its cap); chat is never charged credits, so it stays
  bounded by the rate limits below.
- **Chat** costs no credits, so `CHAT_PER_HOUR` (40) and `CHAT_PER_DAY` (200) in `src/lib/rate.ts` bound it per account,
  on the web route and on MCP `ask_noor`. Before 2026-09-20 nothing did.
- **Onboarding** is free for the first brand and 9 credits for each added brand built from its URL (since 2026-09-30,
  rule 226; the manual brand form makes no model call and is free): the charge goes to Noor in that brand's scope under
  her monthly cap there, after every other refusal and under the run's lock (330 s, owner-token release, so two runs
  never build on one charge), before the stream. It is held on the account record (`User.onboardPaid[scope]`) in the same
  save as the debit: a retry or a revisit reuses it instead of paying twice, a build that fails before the brand is
  saved refunds it and drops the hold in one save (once), and the daily cron refunds a hold no run used for a day, so a
  run the platform killed is never charged twice and never kept without a brand. A failure after the brand was saved is
  not refunded (the brand is delivered and a rerun answers 409). Once per workspace, three runs per
  account per day, so an agency sets up at most three brands a day, and signup is five per IP per hour. The worst case
  an attacker can drive from one address through free first brands is therefore still about $9 an hour; an added
  brand's run is paid for.
- **Brands** are unlimited on every plan (since 2026-09-30, rule 225). What bounds them is a creation rate, not a count:
  10 an hour and 30 a day per account (`brandAddRefusal` in `src/lib/rate.ts`, which says which window refused), plus
  the 9-credit setup and the daily
  onboarding allowance above. Every brand fans out into every cron, which is why an added brand's Sunday plan starts off.
- **Cron** charges `TASK_COST.weekly_plan` (2 credits since 2026-09-30) for the Sunday plan and makes no model call for
  the daily brief. The Sunday plan is on by default only for the default brand; an added brand's is off until the owner
  switches it on in Scheduled tasks (`getSchedule` in `src/lib/schedule.ts`, rule 227). Added brands created before
  2026-09-30 stored the old default (on) in `schedule:{scope}`; on an added brand a stored `weeklyPlan` counts only with
  the `weeklyPlanSetAt` stamp the owner's switch writes, so those brands start off too and are not charged.
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
  again), no run is charged while Claude is paused or without a key, and a failed generation is refunded. A run the
  platform kills after the charge is not refunded, so each routine may leave at most two such charges per week or
  month (`routinetry:`) before it waits for its next period. The worst case for one brand with all four on is 3 + 3 per
  week and 4 + 5 per month in credits, plus at most two lost charges per routine and period when runs are killed.
- **Reports reprice past work.** The profile, the owner's Reports page and the founder overview count credits used as
  items × today's per-item price, `TASK_COST / TASK_COUNT` (`src/app/api/profile/route.ts`, `src/lib/stats.ts`, `src/lib/admin-stats.ts`), so in the
  month of a price change the earlier weekly plans, weekly reports and follow-up sequences are counted at 2, 3 and 4.
  The 9-credit onboarding charge is not a task and is in no "credits used" total; it shows in the balance and in Noor's
  monthly spend for that brand (`agentSpend`). Storing the credits charged on each task is left for a later phase.
  Renders are the exception: every reader counts what they really charged, `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)`
  (an image 1 or 2 by model, a video 12 or 24); since 2026-09-30 the profile does too (`mediaCredits`), and its usage
  row shows the catalogue's image and video ranges instead of a flat 1.

## 6. Where the real numbers live

`meter()` (`src/lib/usage.ts`) records every call under `usage:{email}:{YYYY-MM}` — tokens in and out, call count,
cost in micro-dollars, and since 2026-09-20 the same three numbers **per kind of call**. So the founder console shows,
per account:

- **Users tab:** tokens, cost this month, and a **margin** column (`priceOf`: the plan's list price, or an Agency
  account's deal price, against model cost; red under 50%). Since 2026-09-30 the rows also carry the deal and the
  monthly allowance (`allowanceOf`).
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
