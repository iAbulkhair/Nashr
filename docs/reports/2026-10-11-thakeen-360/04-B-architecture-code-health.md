# Workstream B: architecture and code health (Thakeen 360, 2026-10-11)

Basis: `origin/main` 3bf67673 (worktree HEAD). Live build read from `https://thakeen.com/api/health`: commit 487984f4 (= #312), built 2026-10-10 16:58 UTC (VERIFIED, one GET). Read-only: no build, no install, no `npm audit` (network not allowed), no type-check or lint run. Findings are in `raw/findings-B.jsonl` (23 items, ids B-001 to B-023).

## Summary

1. The code is in good shape for a pre-launch SaaS: layers are clean (lib never imports components or app), strict TypeScript with zero `any` and zero `@ts-ignore` in `src`, every one of 119 route files is referenced by a test, and 803 of 823 documented rules name a unit test.
2. No P0 from this workstream. Five P1s: CI does not build what production builds (B-001), no documented backup/monitoring (B-002), crons live in hPanel/QStash outside the repo and the docs contradict each other on who fires the 15-minute tick (B-003), Hostinger time limits for 300 s routes are unmeasured (B-004), and the app home reads 200+ task keys one command at a time (B-005); plus B-012 (money/publish rules with stated test gaps).
3. `await db.*` in loops: only 2 real sites (conversation search, cron-batch workers); the other 19 are lock spin-waits. Nothing tests the rule.
4. There are zero TODO/FIXME/HACK/XXX markers in `src`, `tests`, `e2e` or `scripts`; deferred work is tracked in prose ("Not pinned", expand/contract notes). The Claude ledger input is in section "Deferral list" below.
5. Docs drift is small but real: Paymob key families and 11 modules are missing from `architecture.md`; "six cron routes" is now seven plus the secretary tick; rule 253 cites an E2E test that does not exist.

## Current state

| Area | State | Evidence | Label |
|---|---|---|---|
| Code size | 508 .ts/.tsx files, 61,601 lines in `src`; 149 files in `src/lib`; 119 `route.ts` (117 under `api`) | wc, find | VERIFIED |
| Tests | 211 unit files (65,133 lines, about 3,685 `it/test` calls by literal count), 9 e2e specs (951 lines); no `.skip` in unit tests | tests/, e2e/ | VERIFIED |
| Rule map | 823 rule rows; 803 start with "test"; unpinned: 19, 679 (process rule), 853, 865; E2E-only: 38, 254, 257, 259, 253 (stale); retired: 255, 256, 307; 163 numbers in 1-986 have no row (reserved: 790-808, 875-899, 924-969, 973-979, others) | docs/system/tests.md, tests/*.md | VERIFIED |
| Hosting | Hostinger Node 22, `next build --webpack`; CI uses Node 24 and Turbopack `next build` | architecture.md:520, ci.yml:61,82 | VERIFIED |
| Data store | Upstash Redis via `src/lib/db.ts` (481 lines, adapter with in-memory fallback refused in production); 365 key-template prefixes in code | db.ts | VERIFIED |
| Crons in repo | `vercel.json`: 8 schedules; 9 cron routes (adds `secretary`) | vercel.json, src/app/api/cron | VERIFIED |
| Crons live | hPanel list and QStash schedule | architecture.md:527, flows.md:596,883 | UNVERIFIED: cannot read hPanel or Upstash |
| Queue | QStash only verifies signatures for `POST /api/cron/secretary` (`src/lib/qstash.ts`); no job queue, long work is cron-batch with resume markers (`crondone:`/`crontry:`) | qstash.ts, cron-batch.ts | VERIFIED |
| Caching | None at app level; prompt caching on Anthropic calls (8 `cache_control`); 30 files under `src/app/[lang]` are `force-dynamic` | grep | VERIFIED |
| Lint/type debt | src: 0 `any`, 0 `@ts-ignore`, 9 `eslint-disable`, 69 non-null assertions, 5 `as unknown as`; tests: 9 `any`, 3 `@ts-expect-error`, 69 `as unknown as` | grep | VERIFIED |
| Dependencies | next 16.3.8, react 19.2.8, anthropic sdk 0.126.0, vitest 5.0.3, typescript 5.9.3, eslint 9.39.5 (deprecated notice in lock) | package-lock.json | VERIFIED; advisories UNVERIFIED |
| Live | `/api/health` ok, commit 487984f4 | curl GET | VERIFIED |

## Findings

No P0. P1 first.

**B-001 (P1, claude) CI does not build what production builds.** `ci.yml:82` runs `npx next build` (Turbopack) on Node 24 (`ci.yml:61`); thakeen.com builds `next build --webpack` on Node 22 (`architecture.md:520`). `tests/hostinger-build.test.ts` only checks the script string and the root layout. A webpack-only failure shows up when the release PR is merged and Hostinger builds. Fix: one extra `--webpack` build step, only on PRs into `production`; add `engines.node`.

**B-002 (P1, founder) No documented backup, error tracking or deep health probe.** `api/health` deliberately never touches Redis (`health/route.ts:10-30`), so a Redis outage reads green. No Sentry/OTel dependency; 147 `console.*` calls. No hit for backup or point-in-time in `docs/system`, `Owner_Tasks_AR.md` or the PRD. UNVERIFIED: a dashboard setting may exist.

**B-003 (P1, both) Crons and the 15-minute Reem tick live outside the repo.** `vercel.json` has 8 schedules and no `/api/cron/secretary`. `architecture.md:210` and `flows.md:596` say a founder-created QStash schedule fires the tick; `architecture.md:527` says the hPanel list contains `*/15 * * * *` for it. The hPanel list is a hand copy checked once (2026-10-08). Founder action: export both lists next session.

**B-004 (P1, both) Time budgets assume Vercel `maxDuration`.** 27 routes export 60-300 s and `deadlineFor` (`media/keys.ts:41`) computes budgets from it; outside Vercel nothing enforces it and Hostinger/hcdn limits for long or streaming responses are not recorded anywhere. UNVERIFIED.

**B-005 (P1, claude) 200+ single GETs per app-home load.** `brand.ts:192` (`listTasks`) and `:307` (`rebuildIndex`) use `pmap(db.get)`; `db.mget` is used at 20 other sites. Callers: `[lang]/app/page.tsx:27`, `api/tasks/route.ts:12`, `api/mcp/route.ts:133`, `api/admin/users/[email]/route.ts:46`. Command count is derived, not measured.

**B-012 (P1, claude) Highest-risk unpinned or half-pinned rules.** Rule 136 (judge write racing another task writer), 40 (video route `trial_over` 402), 310 (chat overflow 429 path), 309 (`LARGE_REPLY` path and MCP tail), 62 (injection tagging prompt text), 19 (chat heartbeat and drop recovery: no test), 755/764 (unverified-owner scheduling, email-change side effects). Each has a neighbouring test, so each is a small addition.

**P2 (one line each; detail in the jsonl)**
- B-006 `await db.` in loops: two sites, no guard test (list below).
- B-007 Jobs and admin pages scale with `users:all` (fine at 100 accounts).
- B-008 `architecture.md` section 3 lacks Paymob (9 keys), `weeklylock`, `crondone`, `crontry`, `modelpick`, three Paymob rate buckets; section 2.5 lacks 11 modules; flows section 47 still says "branch only".
- B-009 Count drift: 116 vs 117 api routes, "six cron routes", variables.md header HEAD 4959f7e, `CHROMIUM_PATH` undocumented.
- B-010 Orphan `src/components/home/Dictionary.tsx` (256 lines) and rule 253's non-existent E2E.
- B-011 Test map summary (this section's counts).
- B-013 One 8-module static import cycle: generate-batch, judge, not-read, notifications, prompt-stamp, schedule, stats, x-stats.
- B-014 Oversized files: `secretary.ts` 1799 lines; Reem family 6,970 lines in 17 files.
- B-015 Lint/type debt low (positive).
- B-016 Dependencies current; no `engines`; eslint 9 deprecated notice; audit not run.
- B-017 CI push trigger and `vercel.json` still serve the retired Vercel project (depends on #319).
- B-018 Pending contract steps (rule 679), see deferral list.
- B-019 PWA icons placeholder (`pwa.ts:24-30`), constant unused.
- B-020 Dead exports: 8 unused, 22 test-only.
- B-021 No app cache layer (by design; depends on B-005).
- B-022 Layers and route coverage clean (positive).
- B-023 Test volume equals src volume; CI heavy.

## Appendix 1: data model, documented vs actual

`architecture.md` section 3 has 201 table rows with 211 key prefixes. Code has 365 distinct template prefixes (many are rate buckets, notification labels and error codes, not keys). Verified missing from the doc:

| Key | Defined at | Note |
|---|---|---|
| `paymob:intent:{ref}`, `paymob:order:{id}`, `paymob:txn:{id}`, `paymob:done:{id}`, `paymob:txlock:{id}`, `paymob:refunded:{id}`, `paymob:refundlock:{id}`, `paymob:attempt:{email}:{day}`, `paymob:card:{email}` | `src/lib/billing.ts:28-36` | payment state; described only in flows section 47 |
| rate buckets `paycheckout:`, `payrenewal:`, `paymobhook:` | `api/billing/checkout/route.ts:25`, `renewal/route.ts:20`, `paymob/webhook/route.ts:20` | |
| rate bucket `modelpick:{email}` | `api/models/route.ts:87` | |
| `weeklylock:{email}` | `src/lib/schedule.ts:107`, `account.ts:184` | 300 s lock |
| `crondone:{job}:{period}:{id}`, `crontry:{job}:{period}:{id}` | `src/lib/cron-batch.ts:34-35` | resume markers for every cron batch |

Everything else spot-checked (user, session, task, tasklock, pending, tidx, rate, sec:*) is documented. Tenant keys are built from `sc(u)`/session data; no `scan`, `keys` or flush calls exist in `src`.

## Appendix 2: crons and queue

| Route | In `vercel.json` | Schedule (UTC) | maxDuration |
|---|---|---|---|
| `/api/cron/weekly` | yes | `0 3 * * 0` | 300 |
| `/api/cron/daily` | yes | `0 5 * * *` | 300 |
| `/api/cron/golden` | yes | `0 1 * * 6` | 300 |
| `/api/cron/media` | yes | `20 5 * * *` | 300 |
| `/api/cron/routines` | yes | `0 6 * * *` | 300 |
| `/api/cron/evening` | yes | `0 15 * * *` | 300 |
| `/api/cron/stores` | yes (twice) | `0 2 * * *`, `0 14 * * *` | 300 |
| `/api/cron/secretary` | no | every 15 min (QStash or hPanel, see B-003) | 60 |

`CLAUDE_PAUSED` is false (`src/lib/model.ts:19`, from the coordinator snapshot; not re-read here). The media cron is daily because the code comment assumed a Vercel plan limit; on Hostinger it could run more often (architecture.md:202).

## Appendix 3: `await db.` inside loops (path:line)

Real, to fix: `src/lib/conversations.ts:162` (sequential `lrange` per thread in `searchConversations`); `src/lib/cron-batch.ts:54,55,60,61` (per-item `incrby`/`set` in the worker loop; bounded by `concurrency`).

Lock spin-waits (retry loops, acceptable): `src/app/api/tasks/[id]/route.ts:36`, `src/lib/governance.ts:172`, `conversations.ts:48`, `brand-proposals.ts:55`, `credits.ts:20`, `brand.ts:369`, `routines.ts:234`, `handoffs.ts:495`, `notifications.ts:51`, `brands.ts:36`, `feed-token.ts:82`, `team.ts:90`, `booking-token.ts:103`, `secretary-gcal.ts:55`, `partners.ts:100`, `secretary.ts:850`.

Method: brace-matched scan of every `for`, `while` and `.forEach` body in `src` for `await`; 86 awaits, 21 on `db.`. Other awaits in loops are HTTP pagination in connectors, model tool loops in `chat.ts`, and stream readers.

## Appendix 4: largest files (lines)

secretary.ts 1799 · secretary-agenda.ts 927 · chat.ts 902 · partners.ts 872 · app-i18n.ts 853 · secretary-calendar.ts 805 · components/app/ChatPanel.tsx 792 · media/jobs.ts 713 · home.ts 650 · handoffs.ts 626 · social-stats.ts 604 · auth.ts 600 · components/app/TodoPanel.tsx 528 · noor.ts 526 · components/app/Inbox.tsx 521 · secretary-meeting.ts 513 · components/admin/Users.tsx 512 · team.ts 495 · credits.ts 491 · db.ts 481. Largest route handler: `api/profile/route.ts` 231.

## Appendix 5: TODO/FIXME/HACK count and the deferral list

Count in `src`, `tests`, `e2e`, `scripts`: 0 (VERIFIED, grep `\b(TODO|FIXME|HACK|XXX)\b`). The real deferrals, for the Claude ledger:

1. Contract step: v1 social snapshot reading, `src/lib/social-stats.ts:91-94` (rule 737).
2. Contract step: legacy `shared:{email}:{platform}` keys, `src/app/api/referral/share/route.ts:10,25,36-40`; `src/lib/referral.ts:122`.
3. Legacy default chat thread `chat:{scope}` with no record, `src/lib/conversations.ts:8`.
4. Expand-only fields awaiting their contract: `Conversation.model`, `Brand.model`, `User.chinaHostingOk` (`docs/system/flows.md:905`).
5. Placeholder PWA icons, `src/lib/pwa.ts:24-30`.
6. Process rule 679 and rules 19, 853, 865 have no test.
7. `docs/system/tests.md` carries 48 "Not pinned" mentions; the 12 most relevant are in B-012.
8. Dead exports and the orphan component (B-010, B-020).
9. 8-module import cycle (B-013).

## Dependencies read from the lockfile

| Package | Version | Note |
|---|---|---|
| next | 16.3.8 | floor 16.3.6 pinned by `tests/dependency-floors.test.ts` |
| react / react-dom | 19.2.8 | |
| @anthropic-ai/sdk | 0.126.0 | `^0.126.0` allows patches only (0.x) |
| @composio/core | 0.22.0 | 0.x |
| @upstash/redis | 1.39.0 | |
| @vercel/blob | 2.8.1 | tied to #319/#320 |
| vitest / typescript / eslint | 5.0.3 / 5.9.3 / 9.39.5 | eslint carries "no longer supported" in the lock |
| image-size | 2.0.4 | held by `overrides` above pptxgenjs' ^1.2.1 |
| `.npmrc` | `min-release-age=7` | rule 699; lock has 7 `@rolldown/binding-linux` entries (CLAUDE.md lockfile check passes) |

## What could not be verified and why

- Live cron schedules (hPanel) and the QStash schedule: not readable without the dashboards.
- Redis backups, uptime monitors, error alerts: dashboards only.
- Hostinger and hcdn request timeouts and SSE buffering: needs a timed call on the live host or staging (a paid or founder-approved action; staging answered 404 at the coordinator's check).
- `npm audit` advisories: network not allowed.
- Type-check, lint and test results on main: no install or build allowed; only CI on the merged PRs vouches for them.
- Whether `nashr-tau.vercel.app` still runs `vercel.json` crons against any shared data: not checked.
- Redis command counts per page: derived from code, not measured.
