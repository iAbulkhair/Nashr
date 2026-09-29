# What a request costs, and where the money goes

Written 2026-09-20. Every number in the tables is arithmetic over two inputs: the list prices in `src/lib/usage.ts`
(`RATES`) and the prompt sizes the code actually builds. Nothing here is a guess about Anthropic's billing; the guesses
are only in the *output* token counts, and those are marked as such. Real per-account numbers are metered and shown in
the founder console — see "Where the real numbers live" at the end.

## 1. The model calls the product makes

| Call | Model | Where | Charged to the customer |
|---|---|---|---|
| `generate` | `claude-opus-5`, `max_tokens` 16000, effort medium | `src/lib/noor.ts` `generate`; every paid batch reaches it through `generateBatch` (`src/lib/generate-batch.ts`), the golden set directly | credits, per `TASK_COST` (a chat `draft_items` pays `countCost`), charged in `generateBatch` before the call |
| `review` | `claude-sonnet-5`, 16000, effort low | `noor.ts` `critique`, runs after every batch unless governance turns it off | free (inside the batch) |
| `judge` | `claude-sonnet-5`, 8000, effort low | `src/lib/judge.ts`, runs after the response via `after()` | free |
| `chat` | `claude-opus-5`, 8000, effort medium, **up to 5 calls per turn** (tool loop) | `src/lib/chat.ts` | **nothing** |
| `onboard` | `claude-opus-5` × 3 parallel, 10000 + 12000 + 12000 | `src/lib/onboard.ts` | **nothing**, once per workspace |
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
review and judge columns by half). Assumptions, stated so they can be argued with: a cache hit on the two cached blocks; 1,200 tokens of adaptive
thinking; and per-item output of 350 tokens (a post, an ad, a GBP entry), 900 (a plan, an OKR set, a script) or 2,500
(an article, a deck, a memo, a PRD). Everything else is measured.

| Request | Items | Credits | Output tok | generate $ | review $ | judge $ | **Total $** | **$ per credit** |
|---|---|---|---|---|---|---|---|---|
| `weekly_plan` | 1 | 1 | 2,100 | 0.062 | 0.014 | 0.013 | **0.089** | **0.0887** |
| `followup_seq` | 7 | 3 | 7,500 | 0.197 | 0.041 | 0.028 | **0.266** | **0.0888** |
| `article` | 1 | 2 | 3,700 | 0.102 | 0.022 | 0.016 | **0.140** | **0.0700** |
| `weekly_report` | 1 | 2 | 3,700 | 0.102 | 0.022 | 0.016 | **0.140** | **0.0700** |
| `growth_experiments` | 5 | 4 | 5,700 | 0.152 | 0.032 | 0.023 | **0.207** | **0.0517** |
| `unit_economics`, `decision_memo`, `feedback_synthesis`, `onboarding_flow` | 1 | 3 | 3,700 | 0.102 | 0.022 | 0.016 | **0.140** | **0.0467** |
| `lead_qualifier`, `dashboard_spec` | 1 | 2 | 2,100 | 0.062 | 0.014 | 0.013 | **0.089** | **0.0443** |
| `sales_script`, `retention_play` | 3 | 4 | 3,900 | 0.107 | 0.023 | 0.018 | **0.148** | **0.0371** |
| `pricing_review`, `cash_forecast`, `prd` | 1 | 4 | 3,700 | 0.102 | 0.022 | 0.016 | **0.140** | **0.0350** |
| `whatsapp`, `gbp` | 3 | 3 | 2,250 | 0.066 | 0.015 | 0.015 | **0.095** | **0.0318** |
| `okrs` | 1 | 3 | 2,100 | 0.062 | 0.014 | 0.013 | **0.089** | **0.0296** |
| `gtm_plan`, `board_deck`, `strategy_review` | 1 | 5 | 3,700 | 0.102 | 0.022 | 0.016 | **0.140** | **0.0280** |
| `ads` | 5 | 5 | 2,950 | 0.083 | 0.019 | 0.017 | **0.119** | **0.0238** |
| `roadmap` | 1 | 4 | 2,100 | 0.062 | 0.014 | 0.013 | **0.089** | **0.0222** |
| `social` | 10 | 10 | 4,700 | 0.127 | 0.027 | 0.024 | **0.178** | **0.0178** |

The calls with no credit attached:

| Request | Cost | Note |
|---|---|---|
| One chat message | **$0.05 – $0.26** | $0.05 per model call; a turn that uses tools runs up to five, and a `generate_content` tool call adds a whole batch on top |
| One onboarding run | **≈ $0.60** | three Opus calls, 20k output tokens between them; free, once per workspace, three per account per day |
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

- The target was at most about $0.05 per credit (founder decision F3). Every model but `vid-cinematic` meets it; at the
  agency plan's $0.1065 per credit (section 4) every row still has a margin.
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

Revenue per credit, from `PLAN_PRICE_SAR` in `src/lib/admin-stats.ts` and `PLAN_CREDITS` in `src/lib/auth.ts`, at
3.75 SAR to the dollar:

| Plan | Price | Credits | Revenue per credit |
|---|---|---|---|
| starter | 149 SAR ($39.72) | 200 | **$0.1986** |
| pro | 399 SAR ($106.37) | 700 | **$0.1520** |
| agency | 799 SAR ($213.01) | 2000 | **$0.1065** |

Put the two tables side by side and three things fall out.

1. **Output tokens are the whole bill.** Most of a batch's cost is Opus output at $25/M. Prompt caching saves about
   four cents a call at best; halving an output would save ten times that. The reviewer and the judge together add
   35–45% on top of the generation call, not the problem.
2. **The cheap-credit, long-output types are the hole.** `weekly_plan` costs $0.089 and is priced at **1 credit**; on
   agency that credit brings in $0.107. It keeps about a sixth, and it is the one type the Sunday cron creates on its own for
   every workspace. `followup_seq` (7 items for 3 credits) is the same shape. `article` and `weekly_report` at 2 credits
   keep about a third of the revenue on agency.
3. **`social` is the best-priced thing in the product** at $0.018 per credit — a 6-to-11× markup depending on plan.
   The pricing is not wrong on average; it is wrong per type, and the spread is 5×.

The obvious moves, cheapest first: reprice `weekly_plan` to 2 credits and `followup_seq` to 5; cap `max_tokens` per
type instead of a flat 16,000; and move the judge to a sampled run (every third batch) rather than every batch.

## 5. What bounds the spend today

- **Credits** bound generation: `charge` runs before the model call, `refund` on failure (`src/lib/credits.ts`).
- **Per-agent monthly caps** (since 2026-09-29), set by the owner per brand on the Governance page, bound what one
  agent can spend in a UTC month: every charging path passes the owning agent and its cap to `charge`, which refuses
  over the cap before the balance moves or a model is called. They bound batches, drafts, images and videos (media renders
  are charged in `startMedia` with the item's owning agent and its cap); chat is never charged credits, so it stays
  bounded by the rate limits below.
- **Chat** costs no credits, so `CHAT_PER_HOUR` (40) and `CHAT_PER_DAY` (200) in `src/lib/rate.ts` bound it per account,
  on the web route and on MCP `ask_noor`. Before 2026-09-20 nothing did.
- **Onboarding** is free: once per workspace, three runs per account per day, and signup is five per IP per hour. The
  worst case an attacker can drive from one address is therefore about $9 an hour.
- **Cron** charges credits for the weekly plan and makes no model call for the daily brief.
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
  type (Dana's weekly report 2, Noor's cart recovery 3, Razan's cash forecast 4, Majed's strategy review 5), one
  generation plus the reviewer and the judge per run, at most once per UTC week or month. Every run passes the owning
  agent and its monthly cap to `charge`, and the weekly cap on scheduled items counts the whole batch before charging,
  including the batches of the brand's other routines running at the same moment (`routinehold:`). A gate checked in
  code skips a run without the input it needs ("idle" or "no_data", no charge, no model call; the next day's cron asks
  again), no run is charged while Claude is paused or without a key, and a failed generation is refunded. A run the
  platform kills after the charge is not refunded, so each routine may leave at most two such charges per week or
  month (`routinetry:`) before it waits for its next period. The worst case for one brand with all four on is 2 + 3 per
  week and 4 + 5 per month in credits, plus at most two lost charges per routine and period when runs are killed.

## 6. Where the real numbers live

`meter()` (`src/lib/usage.ts`) records every call under `usage:{email}:{YYYY-MM}` — tokens in and out, call count,
cost in micro-dollars, and since 2026-09-20 the same three numbers **per kind of call**. So the founder console shows,
per account:

- **Users tab:** tokens, cost this month, and a **margin** column (plan price against model cost; red under 50%).
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
