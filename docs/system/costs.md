# What a request costs, and where the money goes

Written 2026-09-20. Every number in the tables is arithmetic over two inputs: the list prices in `src/lib/usage.ts`
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
| `onboard` | `claude-opus-5` × 3 parallel, 10000 + 12000 + 12000 | `src/lib/onboard.ts` | **nothing**, once per workspace |
| `image_prompt` | `claude-sonnet-5`, 400 | `src/lib/images.ts` | 1 credit (with the image) |

## 2. Prompt size, measured

`systemPrompt` (`noor.ts`) builds three blocks. The first two carry `cache_control`, the third never can (it holds
today's date, the live calendar and the owner's preferences, all of which move).

| Block | Characters | Cacheable |
|---|---|---|
| fixed (rules + the agent's playbook from `content/skills/`) | 10,374 (Razan) – 16,657 (Majed) | yes |
| workspace (brand file + up to 5 × 6,000 chars of memory files) | 1,500 with an empty workspace, 31,500 at the cap | yes |
| today (date, seasons, up to 30 preferences) | 500 – 6,500 | no |

At roughly 3.3 characters per token for this Arabic/English mix, a full batch prompt is **≈ 8,700 input tokens**: about
7,500 of them cacheable and about 1,200 fresh every time.

## 3. Cost of one batch

Assumptions, stated so they can be argued with: a cache hit on the two cached blocks; 1,200 tokens of adaptive
thinking; and per-item output of 350 tokens (a post, an ad, a GBP entry), 900 (a plan, an OKR set, a script) or 2,500
(an article, a deck, a memo, a PRD). Everything else is measured.

| Request | Items | Credits | Output tok | generate $ | review $ | judge $ | **Total $** | **$ per credit** |
|---|---|---|---|---|---|---|---|---|
| `weekly_plan` | 1 | 1 | 2,100 | 0.062 | 0.021 | 0.019 | **0.102** | **0.1024** |
| `followup_seq` | 7 | 3 | 7,500 | 0.197 | 0.062 | 0.042 | **0.300** | **0.1002** |
| `article` | 1 | 2 | 3,700 | 0.102 | 0.033 | 0.024 | **0.159** | **0.0796** |
| `weekly_report` | 1 | 2 | 3,700 | 0.102 | 0.033 | 0.024 | **0.159** | **0.0796** |
| `growth_experiments` | 5 | 4 | 5,700 | 0.152 | 0.048 | 0.034 | **0.234** | **0.0586** |
| `unit_economics`, `decision_memo`, `feedback_synthesis`, `onboarding_flow` | 1 | 3 | 3,700 | 0.102 | 0.033 | 0.024 | **0.159** | **0.0531** |
| `lead_qualifier`, `dashboard_spec` | 1 | 2 | 2,100 | 0.062 | 0.021 | 0.019 | **0.102** | **0.0512** |
| `sales_script`, `retention_play` | 3 | 4 | 3,900 | 0.107 | 0.035 | 0.027 | **0.168** | **0.0421** |
| `pricing_review`, `cash_forecast`, `prd` | 1 | 4 | 3,700 | 0.102 | 0.033 | 0.024 | **0.159** | **0.0398** |
| `whatsapp`, `gbp` | 3 | 3 | 2,250 | 0.066 | 0.022 | 0.022 | **0.110** | **0.0366** |
| `okrs` | 1 | 3 | 2,100 | 0.062 | 0.021 | 0.019 | **0.102** | **0.0341** |
| `gtm_plan`, `board_deck`, `strategy_review` | 1 | 5 | 3,700 | 0.102 | 0.033 | 0.024 | **0.159** | **0.0319** |
| `ads` | 5 | 5 | 2,950 | 0.083 | 0.028 | 0.026 | **0.137** | **0.0274** |
| `roadmap` | 1 | 4 | 2,100 | 0.062 | 0.021 | 0.019 | **0.102** | **0.0256** |
| `social` | 10 | 10 | 4,700 | 0.127 | 0.041 | 0.036 | **0.204** | **0.0204** |

The calls with no credit attached:

| Request | Cost | Note |
|---|---|---|
| One chat message | **$0.05 – $0.26** | $0.05 per model call; a turn that uses tools runs up to five, and a `generate_content` tool call adds a whole batch on top |
| One onboarding run | **≈ $0.60** | three Opus calls, 20k output tokens between them; free, once per workspace, three per account per day |
| One image | **≈ $0.01** | a 400-token Sonnet prompt plus the fal.ai render; charged 1 credit |

## 4. Where the margin actually is

Revenue per credit, from `PLAN_PRICE_SAR` in `src/lib/admin-stats.ts` and `PLAN_CREDITS` in `src/lib/auth.ts`, at
3.75 SAR to the dollar:

| Plan | Price | Credits | Revenue per credit |
|---|---|---|---|
| starter | 149 SAR ($39.72) | 200 | **$0.1986** |
| pro | 399 SAR ($106.37) | 700 | **$0.1520** |
| agency | 799 SAR ($213.01) | 2000 | **$0.1065** |

Put the two tables side by side and three things fall out.

1. **Output tokens are the whole bill.** In a batch, 93% of the cost is Opus output at $25/M. Prompt caching saves about
   four cents a call at best; halving an output would save ten times that. The reviewer and the judge together are
   roughly a third of the generation call, not the problem.
2. **The cheap-credit, long-output types are the hole.** `weekly_plan` costs $0.102 and is priced at **1 credit**; on
   agency that credit brings in $0.107. It is break-even, and it is the one type the Sunday cron creates on its own for
   every workspace. `followup_seq` (7 items for 3 credits) is the same shape. `article` and `weekly_report` at 2 credits
   keep about a fifth of the revenue on agency.
3. **`social` is the best-priced thing in the product** at $0.020 per credit — a 10-to-19× markup depending on plan.
   The pricing is not wrong on average; it is wrong per type, and the spread is 5×.

The obvious moves, cheapest first: reprice `weekly_plan` to 2 credits and `followup_seq` to 5; cap `max_tokens` per
type instead of a flat 16,000; and move the judge to a sampled run (every third batch) rather than every batch.

## 5. What bounds the spend today

- **Credits** bound generation: `charge` runs before the model call, `refund` on failure (`src/lib/credits.ts`).
- **Chat** costs no credits, so `CHAT_PER_HOUR` (40) and `CHAT_PER_DAY` (200) in `src/lib/rate.ts` bound it per account,
  on the web route and on MCP `ask_noor`. Before 2026-09-20 nothing did.
- **Onboarding** is free: once per workspace, three runs per account per day, and signup is five per IP per hour. The
  worst case an attacker can drive from one address is therefore about $9 an hour.
- **Cron** charges credits for the weekly plan and makes no model call for the daily brief.

## 6. Where the real numbers live

`meter()` (`src/lib/usage.ts`) records every call under `usage:{email}:{YYYY-MM}` — tokens in and out, call count,
cost in micro-dollars, and since 2026-09-20 the same three numbers **per kind of call**. So the founder console shows,
per account:

- **Users tab:** tokens, cost this month, and a **margin** column (plan price against model cost; red under 50%).
- **User detail:** a cost-per-request-type table — calls, average cost of one call of that kind, total, tokens.

That makes section 3 checkable: compare the estimate against `byKind.generate.usd / byKind.generate.calls` for a real
account and correct the assumptions here.
