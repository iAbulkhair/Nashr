# Admin Console Benchmark for Nashr

Researched 17 Sep 2026. Claims link to the page they came from. **[unverified]** marks items that came only from search snippets or third-party blogs because the primary page blocked fetching (403/404) or did not state it.

## 1. Executive summary

> **الخلاصة:** في الأسابيع 1–4 يحتاج المؤسس لوحة تعمل من Redis فقط: عدّادات التسجيل والتجارب، جدول مستخدمين مع بحث وفلاتر، درج تفاصيل، تعديل رصيد بسبب إلزامي وسجل تدقيق كامل، ومراقبة تكلفة النماذج. الفوترة وZATCA تنتظر Moyasar/Tap، والتحليلات السلوكية تنتظر PostHog.

**Weeks 1–4 (solo founder, no payment provider):** a Redis-only console with signup/trial/paid counters, a searchable user table (plan, credits, trial end, last activity, model cost), a user drawer with a timeline and a **credit adjustment that requires a reason**, an audit log recording actor, before/after and reason (today's `admin:log` records none of these), model-cost and 429 counters, and cron heartbeats. Yaro Labs calls this the minimum first version: "account search and profile view with subscription, usage, and billing data in a single view" plus an audit log "from day one" ([Yaro Labs](https://yaro-labs.com/blog/saas-admin-panel)).

**Later:** subscriptions, invoices, dunning and ZATCA e-invoices once Moyasar or Tap is wired; MRR movements, cohorts and funnels once an analytics tool is fed; role-scoped admin and safe impersonation before anyone but the founder gets access.

**Two hard findings for a Saudi entity:** Stripe's global page lists the UAE but **not Saudi Arabia** ([stripe.com/global](https://stripe.com/global)), so the Stripe → ChartMogul/Baremetrics stack is not directly available. Neither Moyasar nor Tap mention ZATCA; their "invoices" are payment requests, so Nashr generates the VAT invoice itself.

## 2. Credit-based AI SaaS: how peers expose credits

> **الخلاصة:** الجميع يعرض الرصيد، تكلفة كل إجراء، تاريخ إعادة التعيين، وصناديق انتهاء الصلاحية. المشغّل يرى استهلاك كل مساحة عمل ويتحكم في التجاوز والإشعارات.

- **Enrich Labs / Helena.** The pricing page (live today, unlike the "no public pricing" note in `docs/Enrich_Teardown.md`) lists Starter $39/200 credits, Pro $99/700, Pro Plus $199/2,000; credits "reset on the 1st of each month, and you can top up on demand"; only Pro Plus gets rollover and "priority top-ups"; 1 credit = post/image/chat, 2 = article, 3 = email campaign, 12–24 = video; 3-day trial ([enrichlabs.ai/pricing](https://www.enrichlabs.ai/pricing)). Nashr's `PLAN_CREDITS` (200/700/2000) mirrors this exactly.
- **Jasper.** Credits are per action; "admins can view and govern their workspace's credit allocation" ([jasper.ai/pricing](https://www.jasper.ai/pricing)). PAYG overage with a monthly cap, a per-workspace toggle and alerts at 10k/5k/1k/0 credits **[unverified: [help article](https://help.jasper.ai/hc/en-us/articles/46644376016923-Credits-Based-Pricing) returned 403]**.
- **Lovable.** Credits are "units Lovable uses to measure and pay for usage across your workspace"; 5 daily credits expire at day end; monthly credits expire after 2 months; top-ups last 12 months; per-message cost shows on hover ([lovable.dev/pricing](https://lovable.dev/pricing)).
- **Bolt.** Unused tokens "roll over and stay valid for two months", consumed FIFO; reloads only on top Pro or annual plans, reload tokens "do not expire", reload price "varies based on your plan" ([support.bolt.new](https://support.bolt.new/account-and-subscription/tokens)).
- **Copy.ai** (acquired by Fullcast, Oct 2025 ([copy.ai](https://www.copy.ai/blog/fullcast-acquires-copy-a))): one credit per workflow step, monthly reset **[unverified]**. **Midjourney:** fast GPU hours per plan, no carry-over, extra hours purchasable ([docs](https://docs.midjourney.com/hc/en-us/articles/32016412137741-GPU-Speed-Fast-Relax-Turbo)) **[403]**.

**Pattern:** balance, per-action cost, reset date and expiry buckets for the user; per-workspace consumption, overage toggle and threshold alerts for the operator. Nashr charges before the model call and refunds on failure (`src/lib/credits.ts`) but lacks expiry buckets and a top-up SKU.

## 3. Billing back-office

> **الخلاصة:** Stripe مرجع تعريفات MRR والتحصيل لكنه غير متاح لكيان سعودي. Moyasar وTap يوفران الدفع المتكرر بالتوكن والويبهوك والاسترداد، لا فواتير ضريبية. فاتورة ZATCA مسؤولية نشر.

**Stripe (reference definitions).** Billing overview: MRR ("monthly-normalized value of all active and past_due subscriptions", excluding tax, trials, metered usage), MRR growth split new/expansion/contraction/churn, active subscribers, ARPU, LTV = ARPU ÷ churn, trial conversion (converted ÷ ended, 30 days), churn, cohort retention, AR aging, three CSV exports ([docs](https://docs.stripe.com/billing/subscriptions/analytics)). Recovery: Smart Retries, dunning emails, recovery analytics ([docs](https://docs.stripe.com/billing/revenue-recovery)).

**Lemon Squeezy / Paddle.** Lemon Squeezy is Stripe-owned and migrating merchants to waitlisted "Stripe Managed Payments" ([2026 update](https://www.lemonsqueezy.com/blog/2026-update)); Saudi Arabia is on its bank-payout list ([docs](https://docs.lemonsqueezy.com/help/getting-started/supported-countries)). Paddle: KSA seller eligibility **[unverified]** ([docs](https://developer.paddle.com/concepts/sell/supported-countries-locales/)). Neither offers mada; USD pricing clashes with SAR plans.

**Moyasar (SAMA-supervised).** Recurring = save a card token at first checkout, then POST `/v1/payments` with it on the merchant's own schedule ([docs](https://docs.moyasar.com/guides/tokenization/tokenized-cards)); the SaaS page promises "smart retry and notification systems" ([solutions](https://moyasar.com/en/solutions/subscriptions-and-saas/)) but I found no native subscription object **[unverified]**. Webhooks: `payment_paid`, `payment_failed`, `payment_refunded`, signed with a `shared_secret` ([reference](https://docs.moyasar.com/api/other/webhooks/available-webhooks/)). "Invoices" carry amount, description, `expired_at`, `callback_url`, metadata; no VAT fields ([docs](https://docs.moyasar.com/guides/invoices/creating-invoices/)). Dashboard: transactions, refunds, team roles **[helpdesk unreachable]**.

**Tap Payments.** Dashboard tracks "payments, payouts, refunds, reports" ([tap.company](https://www.tap.company/en-sa/products/billing)). The old Subscriptions API "is no longer supported for new integrations"; use merchant-initiated recurring with `save_card=true`, a Payment Agreement ID and a 5-minute token ([docs](https://developers.tap.company/docs/recurring-payments)); mada recurring **[unverified]**. Webhooks cover charges, invoices, subscriptions with an HMAC-SHA256 `hashstring` and two retries ([docs](https://developers.tap.company/docs/webhook)).

**What Nashr must issue (ZATCA).** Tax invoice: "Tax Invoice" header, seller name/address/VAT number, buyer name and VAT number (B2B), serial number, issue date, line items with quantity and unit price, taxable amount, 15% VAT rate and amount, total, QR code; simplified (B2C) needs fewer fields but still seller VAT number, total including VAT and QR ([Wafeq](https://www.wafeq.com/en-sa/forms/accounting-templates/tax-invoice-form-template), [ClearTax](https://www.cleartax.com/sa/ksa-einvoicing)). Phase 2: XML or PDF/A-3 with embedded XML, UUID, cryptographic stamp, real-time clearance for B2B, 24-hour reporting for B2C, 9-field TLV QR; Wave 24 (revenue over SAR 375,000) by 30 June 2026 ([Wafeq](https://www.wafeq.com/en-sa/tax-and-reporting/qr-code-requirements-for-e-invoices-zatca-saudi-arabia)). Nashr is below any wave, so Phase 1 generation applies once VAT-registered: a provider plus an e-invoicing library, not a dashboard feature.

## 4. Product analytics for operators

> **الخلاصة:** المقاييس القياسية: تسجيلات، تفعيل، DAU/WAU/MAU، احتفاظ، قمع، استخدام الميزات، تسجيلات الجلسات. الطبقات المجانية كافية لسنة.

Standard set: signups, activation (first approved item), DAU/WAU/MAU, retention cohorts, funnels (signup → first generation → first approval → paid), feature usage per agent, session recordings.

- **PostHog** free: 1M events, 5K recordings, 1M flag requests, 1,500 survey responses, 100K exceptions/month, no card ([pricing](https://posthog.com/pricing)); flags roll out "by person property, cohort, or group" ([docs](https://posthog.com/docs/feature-flags)).
- **Mixpanel** free: 1M events/month, funnels and retention, 10K replays, cohorts "Limited" ([pricing](https://mixpanel.com/pricing)).
- **Amplitude** free: 2M events/month, 10K replays, unlimited flags, 1 experiment ([pricing](https://amplitude.com/pricing)).
- **June.so** joined Amplitude on 8 Aug 2025 ([june.so](https://www.june.so/)); do not plan around it.

**Self-built (Redis only):** `SADD active:YYYY-MM-DD email` per authenticated request gives DAU; unions over 7/30 days give WAU/MAU (the `db` adapter only exposes `sadd/smembers`, so unions run in app code; fine below ~5K users). Funnels and recordings need PostHog.

## 5. SaaS metrics dashboards

> **الخلاصة:** الأدوات الثلاث تضع MRR وحركاته أولاً، ثم التسرب، LTV، ARPU/ARPA، تحويل التجربة، وQuick Ratio. لا واحدة تتصل بـ Moyasar أو Tap.

- **ChartMogul:** free under $120K ARR, Pro from $1,188/year; sources Stripe, Chargebee, Paddle ([pricing](https://chartmogul.com/pricing/)); core charts MRR, paid churn, LTV, ARPA ([help](https://help.chartmogul.com/article/282-getting-started-with-charts-in-chartmogul)).
- **Baremetrics:** "MRR breakdown by new, expansion, reactivation, contraction, and churn"; Launch $75/month (its blog still says $49); has a "Universal Connector (API)" ([pricing](https://baremetrics.com/pricing), [comparison](https://baremetrics.com/blog/baremetrics-vs-chartmogul-vs-profitwell)).
- **ProfitWell Metrics (Paddle):** free; MRR, churn, up/downgrades, LTV, active customers, benchmarks; Stripe, Chargebee, Braintree, Recurly, Paddle ([paddle.com](https://www.paddle.com/profitwell-metrics)).
- **Quick ratio** = (new + expansion MRR) ÷ (contraction + churned MRR) ([ChartMogul](https://chartmogul.com/blog/saas-quick-ratio/), [Baremetrics](https://baremetrics.com/academy/saas-quick-ratio)).

With Moyasar/Tap, Nashr computes these from its own subscription records or pushes them to Baremetrics' Universal Connector.

## 6. Platform health

> **الخلاصة:** الفرق الصغيرة تراقب التوفر، الأخطاء، p95، نجاح الكرون، تكلفة النماذج وأخطاء 429. الطبقات المجانية تغطي نشر.

| Tool | Free tier (verified today) |
|---|---|
| Sentry Developer | 5K errors, 5M spans, 50 replays, 1 uptime + 1 cron monitor, 5 GB logs, 1 user; Team $26/mo ([pricing](https://sentry.io/pricing/)) |
| Better Stack | 10 monitors and heartbeats, 30 s checks, 1 status page, on-call; logs 3 GB/3 days ([pricing](https://betterstack.com/pricing)) |
| Axiom Personal | 500 GB/mo ingest, 30-day retention; Cloud $25/mo ([pricing](https://axiom.co/pricing)) |
| Vercel Web Analytics | Hobby 50K events/mo, 1-month window; Pro $0.03/1K ([docs](https://vercel.com/docs/analytics/limits-and-pricing)) |
| Vercel Speed Insights | 10K events/30 days, RES only; Plus $10/project ([docs](https://vercel.com/docs/speed-insights/limits-and-pricing)) |
| Upstash Redis | 500K commands/mo, 256 MB; $0.20/100K after; budget alerts at 70/90% ([pricing](https://upstash.com/pricing/redis)) |
| Highlight.io | Do not adopt: acquired by LaunchDarkly, standalone shut 28 Feb 2026 ([announcement](https://launchdarkly.com/blog/welcome-highlight-to-launchdarkly/)) |

Model API signals: a 429 `rate_limit_error` carries `retry-after`; the tier spend cap (Start $500/mo, Build $1,000/mo) also returns 429 but with `error_code: enforced_spend_limit_reached` and no `retry-after`, so retries are pointless; `anthropic-ratelimit-*-remaining` headers expose headroom ([platform.claude.com](https://platform.claude.com/docs/en/api/rate-limits)). Nashr's crons (`vercel.json`: Sun 03:00 and daily 05:00 UTC) should each ping a Better Stack heartbeat.

## 7. Admin UX patterns

> **الخلاصة:** جدول مستخدمين مع بحث وفلاتر وشرائح، درج تفاصيل مع خط زمني، انتحال آمن بجلسة منفصلة وسبب ومدة وشريط ظاهر، ملاحظات ووسوم، تعديل رصيد بسجل كامل، تصدير CSV، إعلانات وأعلام.

- **User table:** search, filter, "Exportable CSVs or JSON feeds", deactivate "immediately upon revocation", audit events with timestamp, actor, target, action ([WorkOS](https://workos.com/blog/user-management-for-b2b-saas)).
- **Audit log:** "the actor, the entity affected, the previous value, the new value, the timestamp — should be immutably logged from day one"; scope roles so "a tier-1 support agent should be able to apply a credit but not change a plan tier" ([Yaro Labs](https://yaro-labs.com/blog/saas-admin-panel)).
- **Impersonation:** a distinct session with agent identity, reason and a 15–60 min maximum; auto-expire; an undismissable banner; "not a takeover", never log the user out ([Yaro Labs](https://yaro-labs.com/blog/user-impersonation-tool-saas)).

**Nashr gap check** (`src/app/api/admin/users/[email]/route.ts`, `src/app/api/admin/plan/route.ts`): `impersonate` creates a real user session with no banner, reason or expiry; `admin:log` stores only `{email, what, at}`; plan changes and credit grants via `/api/admin/plan` are **not logged at all**. Fix these first.

## 8. Comparison table

> **الخلاصة:** ما تعرضه كل منصة للمشغّل.

| Platform | What the operator view shows |
|---|---|
| Enrich/Helena | Per-plan allowance, monthly reset, on-demand top-up, rollover on top tier (console not public) |
| Jasper | Workspace credit allocation, PAYG toggle and cap, threshold alerts, usage analytics |
| Lovable / Bolt | Per-message cost, credit buckets with expiry, reload eligibility by plan |
| Stripe Billing | MRR and movements, subscribers, ARPU, LTV, trial conversion, churn, cohorts, recovery, CSV |
| Moyasar | Transactions, payment-request invoices, refunds, team roles, webhooks, settlement exports |
| Tap | Payments, payouts, refunds, reports; recurring via saved card + agreement; webhooks |
| ChartMogul / Baremetrics / ProfitWell | MRR breakdown, churn, LTV, ARPA/ARPU, quick ratio, cohorts, benchmarks |
| PostHog / Mixpanel / Amplitude | Funnels, retention, cohorts, replays, flags, surveys |
| Sentry / Better Stack / Axiom | Errors, traces, uptime, heartbeats, status page, logs |

## 9. Recommended Nashr admin console blueprint

> **الخلاصة:** ثمانية أقسام، لكل مقياس اسم وتعريف ومصدر بيانات محدد داخل Redis أو أداة خارجية.

Existing keys: `users:all`, `user:{email}` (plan, credits, trialEnds, createdAt, renewedAt, suspended), `usage:{email|_all}:{YYYY-MM}:{in|out|calls|usd_micro|kind:*}`, `task:{scope}:{id}` (quality.score, status), `fb:{email}:{agent}:{up|down}`, `fblog:{email}`, `admin:log`. **new** marks keys to add.

**A. Overview (today / 7d / 30d)**

| Metric | Definition | Source |
|---|---|---|
| Signups | users created in window | **new** `signups:YYYY-MM-DD` INCR in `createUser`; backfill from `createdAt` |
| Trials active / expiring 24h | plan=trial, trialEnds > now / < now+24h | scan `users:all` → `user:*` |
| Trial → paid (30d) | paid in window ÷ trials ended in window (Stripe definition) | **new** `conv:YYYY-MM-DD` INCR on upgrade |
| Paid by plan | plan ∈ {starter, pro, business, agency}, not suspended | `user:*` |
| MRR (SAR) | Σ `priceOf(u)` (`src/lib/pricing.ts`) for paid, unsuspended users: the list price (299 / 499 / 999 since 2026-09-30), or an Agency account's deal price (999 without a valid deal) | `user:*`; later subscription records |
| Model cost (USD) | `usd_micro`/1e6 this month | `usage:_all:{M}:usd_micro` |
| Gross margin | (MRR÷3.75 − model cost) ÷ (MRR÷3.75) | derived |
| Cost per credit | model cost ÷ credits consumed | **new** `credits:spent:_all:{M}` INCR in `charge()` |
| 429 / refunds | model calls rejected or refunded | **new** `health:429:{date}`, `health:refund:{date}` |

**B. Users.** Table: search email/name/phone; filters plan, suspended, lang, trial expiring, credits < 10, no task in 14 days, avg score < 70; saved segments; CSV export. Drawer: what `/api/admin/users/[email]` returns plus a timeline merging `admin:log` (by target), `fblog`, notifications and task events; **new** `admin:notes:{email}` (list) and `admin:tags:{email}` (set); existing actions plus add/remove credits **with mandatory reason**.

**C. Billing (needs provider).** Subscriptions with status/next charge; **new** `invoice:{id}` with the ZATCA fields and `zatca_status`; **new** `pay:events` webhook log (signature-checked); failed payments, retry state, refunds. Until then: plan and `renewedAt` only.

**D. Usage and cost.** Per-kind counters (`kind:generate|review|chat|onboard|image_prompt|tool|judge`), top 10 accounts by `usd_micro`, credits vs cost per account; give `cache_read_input_tokens` its own counter (today folded into `in`) to show cache hit rate.

**E. Quality.** `globalMetrics(days)` via `/api/admin/evals`: thumbs per agent, average judge score, share below 70, approval rate from `stats.ts`.

**F. Health.** **new** `cron:last:{daily|weekly}` set by handlers plus Better Stack heartbeats; Sentry errors; Speed Insights RES; Upstash commands; Anthropic remaining headers in **new** `health:ratelimit:latest`.

**G. Audit log.** Entries become `{actor, target, action, before, after, reason, at}`; log `/api/admin/plan` POSTs; add reason and expiry to impersonation.

**H. Announcements and flags.** **new** `announce:current` `{ar, en, href, until}` rendered as an in-app banner; **new** `flag:{name}` `{pct, allow:[emails]}` behind an `isOn(name, email)` helper. Move to PostHog flags only when replay correlation matters.

### Do now vs later

> **الخلاصة:** ابدأ بما يعمل من Redis؛ أجّل ما يعتمد على مزوّد دفع أو أداة تحليلات.

| Do now (Redis only) | Needs a payment provider (Moyasar or Tap) | Needs an analytics tool (PostHog) |
|---|---|---|
| Sections A, B, D, E, G, H; signup/conversion/credit counters; reason-required adjustments; cron heartbeats; Sentry and Speed Insights free tiers | Section C; real MRR from subscription records; failed payments, retries, refunds; ZATCA invoices with QR; churn and quick ratio from billing events; top-up SKU | Funnels (signup → first approval → paid), retention cohorts, feature usage per agent, session recordings, percentage flags |

**Check before committing:** Moyasar native subscription object; mada on Tap merchant-initiated recurring; Paddle seller eligibility for a KSA company.
