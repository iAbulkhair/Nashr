# Workstream D: AI agents, models and cost

Date 2026-10-11. Code basis: origin/main 3bf67673 (also this worktree). Live basis: origin/production 487984f4. No paid calls, no golden runs, no production access. Findings: `raw/findings-D.jsonl` (23 items, D-001 to D-023).

## Summary

1. No P0 in this workstream. Models are tidy: only Opus/Sonnet/Haiku 5.5 appear in `src`, routing has one entry point, Straitly is default-off, `CLAUDE_PAUSED = false`.
2. Live (`production`) does not have #298 (router, tiers) or #318 (billed-call metering). Its console undercounts cut or refused calls until the next release PR (D-001).
3. Money risk is chat plus credits together: at documented ceilings Pro and Business can lose money (-6% and -8%), and the fair-use clause and daily margin alert the PRD calls required are not built (D-002).
4. Quality evidence is thin: golden has 19 cases for 18 of 26 task types, never touches chat, run history is unreadable from here, and the official staging comparison is blocked (D-003, D-004, D-008).
5. Data-hosting risk from models is zero in code today (catalog is Claude-only, west-hosted). The real exposures are Straitly if ever enabled (not in the privacy text, D-005) and the three media providers (D-007).

## Current state

| Area | State | Evidence | Label |
|---|---|---|---|
| Model ids in src/scripts/e2e | only `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | grep; `catalog.ts:66-106` | VERIFIED |
| Non-Claude or China-hosted entry in catalog | none; guards exist (`route.ts:84,158`, `catalog.ts:184`) | code | VERIFIED |
| Routing | `route(purpose)` is the only place that names a model; per-type writer/reviewer from `TASK_MODELS` (rule 901): Opus 5.5 writes 10 types, Sonnet 5.5 16, Sonnet reviews all 26, Sonnet judges (rule 903), Haiku does image prompts and free tools | `route.ts:42-53`, `task-models.ts:19-35` | VERIFIED main; rule 901 also in production |
| Straitly gateway (#298) | merged 2026-10-10 09:36Z; off unless `LLM_PROVIDER=straitly` and `STRAITLY_API_KEY`; fallback to Anthropic on 5xx via `ANTHROPIC_API_KEY`; not in production code | `model.ts:30,39,133`; `gh pr view 298` | VERIFIED |
| Claude pause | `CLAUDE_PAUSED = false` (main and production) | `model.ts:19` | VERIFIED |
| Metering (#318) | all 8 `messages.stream` call sites wrapped by `metered()`; no `messages.create` left on main; production still has `messages.create` in the judge | grep; `judge.ts:95` on production | VERIFIED |
| Prompts | 11 playbooks in `content/skills` (157 KB, about 15.4 KB per agent file, size caps tested), 8 industry playbooks in code, hash stamps (`skills`, `review`, `industry`, `code`) on every task and golden result | `prompt-stamp.ts`, tests | VERIFIED |
| Golden set | version 6, 19 cases, weekly cron in `vercel.json` (Sat 01:00 UTC); last official run date and score trend not readable (production Redis) | `golden.ts:24` | code VERIFIED, history UNVERIFIED |
| Judge | Sonnet 5.5, five-dimension rubric with automatic-fail caps; cheaper judge (Jev) tested and removed 2026-10-01 | `judge.ts`; PR #238 merged | VERIFIED |
| Chat | Sonnet 5.5 default, ceiling $0.14 per message (Opus pick $0.28, counts 2 allowance units); quality eval skipped by founder decision, watch window to about 2026-10-19 | `pricing.ts:194`, `costs.md:268` | VERIFIED; memory's "$0.35 per message" is STALE |

## Unit economics from documented numbers only

Inputs (all in code or `costs.md`): list prices 299 / 499 / 999 SAR ex-VAT, credits 300 / 700 / 1,500, chat allowance 250 / 650 / 1,300, 3.75 SAR per USD, 60% floor, so the ceiling is $0.07104 per credit (`pricing.ts:40-42,127,135,167`). Revenue per month: $79.73 / $133.07 / $266.40.

| Plan | Credits at ceiling | Chat at $0.14 ceiling | Both | Margin if both |
|---|---|---|---|---|
| Starter | $21.31 | $35.00 | $56.31 | 29% |
| Pro | $49.73 | $91.00 | $140.73 | -6% |
| Business | $106.56 | $182.00 | $288.56 | -8% |

Credits alone at the ceiling give margins of 73% / 63% / 60%. This is the worst case; only abuse reaches it. At the spec's estimate of $0.032 per chat message, a fully used chat allowance costs $8.00 / $20.80 / $41.60 (10% / 16% / 16% of revenue, `costs.md:257-262`); that estimate is not measured (D-013).

Other documented numbers: trial worst case $7.75 per signup (50 credits at ceiling plus 30 messages at $0.14); added brand onboarding costs 9 credits ($0.64 at ceiling) against a typical $0.57 run and a retry worst case near $1.8; media renders are at most $0.0588 per credit (`vid-cinematic`), under the ceiling; an X refresh is $0.06 per credit. Floor basis: list price, so partner discount, commission and payment fees are outside it (D-010).

The 100-clients study (memory, artifact not reopened) predates rules 901 and 970 and is stale (D-012). Its last stated results: ceiling case -114k SAR, full use -4.2k, expected +33.6k, budget ask about 166k plus 60k cash.

## Findings, P0 first

No P0.

P1
- D-001 Live site lacks #298 and #318 (metering and router not live). Put in next release PR.
- D-002 No fair-use clause or daily margin alert; chat plus credits can exceed plan revenue on Pro and Business.
- D-003 Golden coverage: 8 task types never covered (weekly_plan, gbp, cart_recovery, lead_qualifier, cash_forecast, retention_play, roadmap, onboarding_flow), three of them run unattended by crons; no chat, onboarding, meeting or image-prompt cases.
- D-004 Staging (404, no Redis) blocks the official direct-versus-Straitly golden comparison, so no Straitly or Haiku decision can be made properly.
- D-005 Straitly is not a disclosed processor and would carry all Claude traffic; privacy text also still names Vercel.
- D-015 Old Vercel project still has golden and other crons and may hold a model key (UNVERIFIED).

P2: D-006 China-hosted model guards and pending shortlist; D-007 media providers' hosting undocumented; D-008 judge not independent of writer for 16 types and golden noise equals the effects measured; D-009 Haiku-as-writer trial inside noise; D-010 floor excludes discounts, commission and fees; D-011 costs.md still carries Opus 5 dollar tables; D-012 100-clients study stale; D-013 real cost per message never measured; D-014 residual metering gaps; D-016 golden cron on Hostinger unknown; D-017 server-side fallback model unknown; D-018 trial and onboarding worst cases; D-019 chat quality drops on large workspaces; D-020 prompts inventory (done); D-021 model policy (done); D-022 stale memory notes; D-023 judge sampling saving.

Data-hosting summary (D-005 to D-007): Anthropic is the only model host used today (US, outside the Kingdom; cross-border basis belongs to workstream C). Straitly: off. China-hosted models: not reachable. Media: fal.ai, kie.ai, Higgsfield receive customer-derived prompts and images, disclosed in `legal.ts:13`, hosting unknown.

## What could not be verified and why

- Golden run dates, scores and trend: stored in production Redis; reading production is forbidden here. Needs the founder to open the Golden panel.
- Whether hPanel has the golden cron, and whether the old Vercel project holds `ANTHROPIC_API_KEY`: dashboards are out of scope.
- Straitly's hosting, retention and Claude route; kie.ai, fal.ai and Higgsfield hosting country: not in the repo, no web research done.
- The all-models test numbers, the Haiku trial and the Chinese-model results (memory and an artifact): throwaway scratchpad results, not reproducible without paid calls.
- The Anthropic Console total (about $34.5 for 2026-09-11 to 2026-10-10) appears only in a memory prompt snippet; the code comment in `catalog.ts` makes the match claim.
- The 100-clients artifact and its `compute()` model: not opened; memory summary only.
- Paymob fee assumption (2.5% plus 1 SAR) is from memory.
- What Anthropic's server-side fallback `default` resolves to (D-017).
