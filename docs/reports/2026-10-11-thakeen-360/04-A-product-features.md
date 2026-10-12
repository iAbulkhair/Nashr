# 360 study, workstream A: product and feature map

Date: 2026-10-11. Base: origin/production 487984f4 (live), origin/main 3bf67673 (merged). Read-only study. Evidence labels: VERIFIED (read in code or fetched live), STALE (older source, newer state differs), UNVERIFIED (needs a key, a dashboard or a founder answer).

## Summary

1. All 8 agents (Noor, Sami, Razan, Faris, Dana, Majed, Layan, Reem) plus the judge and the reviewer are built and live; `src/lib/agents.ts` is identical on production and main. Reem owns no task type (`tasks: []`).
2. Trial is 3 days in code (`src/lib/auth.ts:237`) and in about 20 copy places; the PRD and the founder decision say 7 days.
3. Four dormant integrations ship as code only: Paymob (PAYMOB_*), Composio connectors (COMPOSIO_*), Reem calendars (GOOGLE_*/MICROSOFT_*), media providers. Straitly routing is off unless `LLM_PROVIDER=straitly`, but the model picker, tiered credits and metering ship on the next release regardless.
4. Live marketing is mostly consistent with code. Exceptions: Emirati/Kuwaiti dialect and Salla/Zid import claims, the "unlimited brands" copy against the 1/1/2/5/agency decision, and (on main only) a "عملاء جربوا ذكين" heading that contradicts the no-invented-customers rule.
5. Many PRD launch items are designed and not built: Google sign-in, phone verify, console 2FA, fair-use and margin alert, price lock, founder perks, annual plan, brand limits, agent scope Part B (exists only on a local branch).

## Current state table

State words: LIVE = in origin/production. MERGED = on origin/main only. DORMANT = code live, a key or approval missing. DRAFT = open draft PR. DESIGNED = spec or PRD only. REMOVED.

| Feature | State | Evidence |
|---|---|---|
| Noor marketing (weekly_plan, social, article, whatsapp, ads, gbp, cart_recovery) | LIVE | agents.ts:38 |
| Sami sales (sales_script, lead_qualifier, followup_seq) | LIVE | agents.ts:47 |
| Razan finance (pricing_review, unit_economics, cash_forecast) | LIVE | agents.ts:56 |
| Faris GTM (gtm_plan, growth_experiments, retention_play) | LIVE | agents.ts:65 |
| Dana reports (weekly_report, board_deck, dashboard_spec) | LIVE | agents.ts:74 |
| Majed executive (strategy_review, okrs, decision_memo) | LIVE | agents.ts:83 |
| Layan product (prd, roadmap, feedback_synthesis, onboarding_flow) | LIVE | agents.ts:91 |
| Reem secretary: to-dos, follow-ups, ICS feed, Cal.com/Calendly bookings | LIVE | agents.ts:100, secretary.ts |
| Reem calendars B2b + B3 (Google, Microsoft) | MERGED, DORMANT | registry.ts gcal/mscal need GOOGLE_*/MICROSOFT_* |
| Writer/reviewer table (Opus 5.5 writes 10 types, Sonnet 5.5 writes 16, Sonnet 5.5 reviews all) | LIVE | task-models.ts |
| Judge (Sonnet) and reviewer | LIVE; golden run on 5.5 UNVERIFIED | task-models.ts |
| Jev judge | REMOVED (evaluation failed) | memory jev-evaluation |
| Pre-5.5 models | REMOVED on main only | 6db81ec9 |
| Chat, approvals, governance, teams, entitlements A, top-ups | LIVE | |
| Partner/affiliate program | LIVE (any-country partners) | partner-rules.ts |
| Model picker (`/api/models`, `model-picker.ts`), tiered credits, metering (rules 980-986) | MERGED, ships although Straitly off | catalog.ts: 3 Claude models |
| Straitly routing | MERGED earlier, default off | model.ts:31 |
| Skills portal | DRAFT #316 | |
| Paymob KSA payments | LIVE code, DORMANT (PAYMOB_*) | paymob.ts, billing.ts:24 |
| Composio connectors and social analytics | LIVE code, DORMANT (COMPOSIO_*, app approvals) | composio.ts |
| Media (image, video) providers | LIVE code, DORMANT (keys) | media/config.ts |
| Salla, Zid connectors | LIVE code, partner apps not approved | registry.ts:94-95 |
| WordPress, WooCommerce, Telegram | LIVE | |
| Public pages, free tools, vs pages, customers, enterprise, affiliates | VERIFIED live (curled) | scratchpad live_*.txt |
| Turnstile | LIVE, fails open when unset | turnstile.ts |
| PWA | LIVE | |
| Founder console / admin shell | LIVE (#304 via #312) | |
| Waitlist API route | LIVE, orphaned (no UI caller) | api/waitlist/route.ts |
| ZATCA invoice | STUB (returns null) | invoice.ts |
| Brand limits 1/1/2/5/agency | DESIGNED (code says unlimited, brands.ts:9) | |
| Agent scope Part B | local branch `claude/entitlements-part-b` only | |
| Google sign-in, phone verify, console 2FA, mentoring, health score, price lock, annual plan, founder perks, fair-use, margin alert, light mode, cost-before-run, per-member approval rate | DESIGNED, not built | PRD v3.2 |

## Findings

### P0
- A-001 Manual-payment fallback mails hello@nashr.ai (`billing/page.tsx:124`, `TopupCard.tsx:47`); the domain does not resolve (NXDOMAIN). Impact only if SUPPORT_WHATSAPP is unset on live (UNVERIFIED). Also in `i18n.ts:284,436`.
- A-002 Main-only #311 renames the scenes section "عملاء جربوا ذكين" and drops the "illustrative" label (`home.ts:488`). That breaks the no-invented-customers rule and the live `/customers` page. Founder decision before the release PR.
- A-003 `/p/<code>` redirect sends users to 0.0.0.0:3000 on live (L-series leftover). Fix #313 is on main only, waits for a release PR.

### P1
- A-004 Trial is 3 days (`auth.ts:237`, `i18n.ts:249,271,401,423`, `AuthForm.tsx:20-21`, `help.ts:41`, `ProfilePanel.tsx:187`, `ToolForm.tsx:49`); PRD and decision say 7.
- A-005 Brands are unlimited in code and copy (`brands.ts:9`, `i18n.ts:247`); decision is 1/1/2/5/agency.
- A-006 Model picker, tiered credits, metering ship on the next release while Straitly is off; catalog is Claude-only; spike and golden on 5.5 UNVERIFIED.
- A-007 Live pricing, enterprise and vs pages claim Emirati and Kuwaiti dialects, unlabelled (`app-i18n.ts`); PRD confirms Saudi only.
- A-008 Live vs pages name competitors, quote a competitor price and claim Salla/Zid import (`pages-vs.ts`); Salla/Zid apps are not approved.
- A-009 Partners are accepted from any country (`partner-rules.ts`).
- A-010 Agent scope Part B exists only on local branch `claude/entitlements-part-b`; at risk of loss.
- A-011 Routines are opt-in (`routines.ts` dueRoutines needs `sched.routines[id] === true`); decision was to run automatically.
- A-012 Trial video can be requested at any time (`media/jobs.ts:56,152`); cost exposure when media keys are set.
- A-013 nashr-tau.vercel.app still serves and is indexable; #319 is a draft.
- A-014 Free-tool and trial rate limits rely on `clientIp` behind the Hostinger CDN (rule 773), UNVERIFIED.
- A-015 PRD launch items unbuilt: Google sign-in, phone verify, console 2FA, fair-use, margin alert, 6,000 rule, price lock, founder perks, annual plan.
- A-016 Live copy says annual plan "قريباً" (`i18n.ts:248`) with no build behind it.

### P2
- A-017 Dead `waitlist` copy ("first 100 brands, two months free", `i18n.ts:277,429`) is not rendered anywhere; leftover L044 is not a live claim. Remove the dictionary entry and the orphaned route.
- A-018 PRD v3.2 is stale: lists #298, #311, #313, #314 as open, says production matches main, cites rules up to 901.
- A-019 `.wt` is a stray PRD v3.1 copy tracked on main.
- A-020 `architecture.md:513` and `Owner_Tasks_AR.md` are stale.
- A-021 `FALLBACK_ORIGIN` is still the Vercel host (`origin.ts:15`).
- A-022 Vercel Blob dependency conflicts with the plan to retire Vercel (#320).
- A-023 `PAYMOB_CHARGES_VAT = true` and the ZATCA stub depend on an accountant decision.

## What could not be verified and why

- Production env vars (SUPPORT_WHATSAPP, PAYMOB_*, COMPOSIO_*, GOOGLE_*, MICROSOFT_*, media keys, TURNSTILE_*): no access to the Hostinger panel. Dormancy is inferred from code gating only.
- Golden and judge quality on 5.5, and the Straitly spike result: eval outputs not in the repo.
- Whether Salla, Zid, Meta, LinkedIn, TikTok, Snapchat app approvals exist: dashboard-only.
- Client IP handling behind the Hostinger CDN: needs a live header test.
- nashr.ai DNS was checked by lookup only; no mail test.
- Draft PR content (#316 to #320) read by title and memory, not diffed line by line.
