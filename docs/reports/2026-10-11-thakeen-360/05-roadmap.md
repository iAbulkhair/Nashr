# Roadmap: 2 weeks and 6 weeks (2026-10-11)

How to read this file:
- Rows are ordered by dependency. Ids point to `findings.jsonl` or to the founder ledger (F-NNN in `02-founder-ledger_AR.md`).
- **Owner:** founder, claude, or both.
- **Batch:** the release PR (main to production) that carries the change. "off-code" means a dashboard or business step with no deploy.

## Rules every batch follows (CLAUDE.md, rules 674-679, 772, 789)

- Work in progress sits on a branch with no PR. A draft PR is opened only when the work is done. Each finished step gets one push. `gh pr ready` is run once.
- `npm run check` and `npx next build` pass locally before any push. CI is never re-run without a change.
- A release is one PR from main to `production`, merged by the founder. Merging to main is not publishing. Before each release:
  - staging smoke runs (once staging has Redis, F-002)
  - the scanner shows 0 advisories
  - the live smoke after it is 6/6
  - a `live-YYYY-MM-DD-N` tag is set
- Stored shapes change in two releases: expand first, contract in a later release. The 77 commits now waiting are all expand-only (F-012), so R1 is low-risk.
- Batch releases. At most one release per week unless a P0 live bug needs one.

## Week 1 (Oct 11-17): stop the bleeding, release R1

| # | Item | Owner | Depends on | Batch |
|---|---|---|---|---|
| 1 | Decide the homepage heading wording «عملاء جربوا ذكين» (I-001) | founder | - | R1 |
| 2 | One branch: heading copy + hello@nashr.ai replaced by a working address in billing, TopupCard and the waitlist message (G-007) | claude | 1 | R1 |
| 3 | Finish #317: push the renumber `d6307768` (rows 970-973 no longer collide with main), Vercel recheck, `gh pr ready` once (E-001, J-005) | claude | - | R1 |
| 4 | #319: stop nashr-tau + dashboard steps; rotate WAITLIST_ADMIN_KEY; set APP_ENV and remove VERCEL_ENV in hPanel (C-001) | both | - | R1 + off-code |
| 5 | Release R1 PR main to production: carries #298 #311 #313 #314 #315 #318 + items 2-4. Fixes the live `/p/` bug (F-001) | both | 1-4 | R1 |
| 6 | Upstash backup, provider spend limits, real signup and forgot-password mail test on thakeen.com (F-005, H-013) | founder | - | off-code |
| 7 | Trial length answer: 3 or 7 (I-004) | founder | - | R2 |

Exit check:
- live `/p/TEST123` lands on `https://thakeen.com/ar/app/signup?...`
- nashr-tau no longer serves
- the founder console Cancel does nothing
- hello@ no longer appears in the UI

## Week 2 (Oct 18-24): operating basics, release R2

| # | Item | Owner | Depends on | Batch |
|---|---|---|---|---|
| 8 | Staging env in hPanel (separate KV_REST_API_*, CRON_SECRET, CONNECT_SECRET, APP_ORIGIN, STAGING_ACCESS_KEY) so the pre-release gate runs (F-002) | founder | - | off-code |
| 9 | Production monitoring + `/api/health` that touches Redis (F-004) | claude | 8 | R2 |
| 10 | CI build parity: webpack on Node 22 like Hostinger (B-001) | claude | - | R2 |
| 11 | Turnstile keys + verify the client IP header order behind hcdn (C-005) | both | - | R2 |
| 12 | Push `claude/entitlements-part-b` (founder yes), back up its ledger, finish tasks 6-9 (J-003) | claude | - | R3 |
| 13 | Trial code change to the decided length + send the #191 correction (I-004, I-006) | both | 7 | R2 |
| 14 | Deck fix: remove the invented quote, prices 299/499/999 + VAT, trial per decision (I-002) | claude | 7 | off-code |
| 15 | Privacy and terms draft for the lawyer (C-002, C-009, D-005) | claude | - | R2 or R3 |
| 16 | Company papers started (G-002) | founder | - | off-code |

## Weeks 3-6 (Oct 25 to Nov 22): money and growth, releases R3 and R4

| # | Item | Owner | Depends on | Batch |
|---|---|---|---|---|
| 17 | Accountant answer (VAT, ZATCA, withholding), then Paymob test keys (G-003) | founder | 16 | off-code |
| 18 | Paymob test run, fix refund-leaves-plan-active (G-005), then PAYMOB_LIVE (G-001) | both | 17 | R3 |
| 19 | Lawyer review, then publish privacy and terms (C-002) | both | 15 | R3 |
| 20 | #316 skills portal: merge main just before merge, resolve 3 conflicts, admin second factor first (C-004) | claude | - | R3 |
| 21 | Brand limits per plan (A-005, plan 2026-10-09-brand-limits) | claude | 12 | R3 |
| 22 | Fair-use clause + daily margin alert (D-002) | claude | 19 | R3 |
| 23 | Composio and Reem calendar keys and app approvals (H-001, CL-008) | founder | - | off-code |
| 24 | Media storage on Hostinger disk (#320) after the hPanel checklist | both | 8 | R4 |
| 25 | Founding-20 mechanics: pay-first offer, codes, page (I-005) | both | 18 | R4 |
| 26 | UI phases 1-5, core components first (E-series) | claude | 3 | R3/R4 |

## Not scheduled (needs a founder decision first)

- Naming providers on public pages (E-014): keep or remove Anthropic, fal, kie and Higgsfield from the privacy and help pages.
- Golden coverage for 8 missing types and chat (D-003). Each run is paid, so it needs the founder's yes.
- Branch, worktree and session cleanup (J-006). It removes nothing without the founder's yes.
