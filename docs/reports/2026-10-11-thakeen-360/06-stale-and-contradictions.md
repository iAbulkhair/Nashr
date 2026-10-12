# Stale claims and contradictions (2026-10-11)

This file covers three places:
- memory files in `~/.claude/projects/-Users-ihejazy-projects-nashr/memory/`
- repository docs
- GitHub issues

Each row says what is written, what is true, how it was checked, and the fix. Memory rows marked "fixed" were corrected in this study with a dated line. Nothing was deleted. Repository docs and issues were not changed: they are listed for the next docs push and for the founder.

## Memory

| File | Written | Fact (checked 2026-10-11) | Label | Fix |
|---|---|---|---|---|
| nashr-local-checks, straitly-model-routing | follow-up task_8d575e38 open | Shipped as PR #315 (rules 905-907); session archived | STALE | fixed (dated line) |
| nashr-local-checks | #320 reserves 991-1015, free 1016+ | PR #320 title says 991-1010 | STALE | fixed; check the PR before using 1011+ |
| nashr-local-checks | #317 uses 960-969 + 974-977 | Pushed head still defines 970-973 (collides with main 970-972); renumber d6307768 is local only | STALE on origin | fixed (note) |
| nashr-local-checks | Part B: 7 commits, tasks 1-5 | 9 commits ahead, rules 790-802, tasks 1-5 clean, 6 implemented and awaiting re-review, 7-9 not built | STALE | fixed |
| thakeen-staging-release-flow | staging.thakeen.com lock on | `/` returns 404 from hcdn; no Redis env, so the gate cannot run | STALE | fixed |
| nashr-pricing-teams | chat allowance $0.35/message | `src/lib/pricing.ts:194` says $0.14 (PR #252) | STALE | fixed |
| thakeen-hostinger-deploy | Vercel nashr-tau is the old public project | Still serves main HEAD 3bf67673 with old env, weekly golden cron, indexable | Incomplete | fixed (dated line) |
| chat-sonnet-55-paused | file name says paused | `CLAUDE_PAUSED = false` (`src/lib/model.ts:19`) | Misleading name | note only |
| (missing) | no file for entitlements A/B or agent scope | Part B is the largest unpushed work | Gap | covered by the new 360 memory file |
| thakeen-100-clients-budget | v2 margins | Predates rules 901 (pick pricing) and 970 (5.5 only); costs.md still uses Opus 5 prices (D-series) | STALE | needs a rerun (no paid calls) |

## Repository docs

| Location | Written | Fact | Finding |
|---|---|---|---|
| `docs/system/flows.md` §52 | production branch does not exist; merges to main reach customers | `production` branch is live since 2026-10-08 | J-002 |
| `docs/Owner_Tasks_AR.md` (header 2026-10-08) | Vercel Pro, nashr.ai, MobPay, PAY_LINK_*, QStash, CLAUDE_PAUSED=true, #243 review | All obsolete or done (25 rows in `02-founder-ledger_AR.md`, "Stale Owner_Tasks items") | K |
| `docs/Owner_Tasks_AR.md:258-287` | platform callbacks on nashr-tau.vercel.app | Must be thakeen.com | K, H |
| CLAUDE.md, `.github/workflows/ci.yml` | Vercel preview deploy wording | Vercel is retiring (#319) | CL-005 |
| `docs/system/costs.md` | Opus 5 prices | 5.5 family only (rule 970) | D |
| Privacy page | processors list, Vercel hosting | Hostinger, Straitly, kie, Higgsfield missing or stale | C-002, D-005 |
| Specs dictionary-onboarding, pwa-install | status says draft or not merged | Both merged | CL-014 |
| 20 plans in `docs/superpowers/plans/` | all checkboxes open | Most built (see 03 CL-015) | CL-015 |
| PRD | trial 7 days | code 3 days; founding-20 plan says pay first | I-004 |
| Deck | prices 149/399/799, 7-day trial, invented quote | prices 299/499/999 + VAT | I-002 |
| Dictionaries | "first 100 brands two months free" | Not rendered anywhere (dead entries) | I |

## GitHub issues

- All 23 `owner-task` issues and `founder-decision` #193 are open.
- With evidence, these can be closed:
  - #193: decided 2026-09-29/10-01, #236 merged.
  - #49: email verification is live via #297.
  - #11: MAIL_FROM was set on 2026-10-08.
  - #8: the domain is thakeen.com.
- The founder closes them, or says yes and Claude closes them.

## Contradictions between sources

1. **Trial length.** The code says 3 days, the PRD and the founder's 2026-10-05 decision say 7, and the founding-20 plan says no trial. (I-004)
2. **Homepage proof.** «عملاء جربوا ذكين» over 24 invented quotes conflicts with the CLAUDE.md rule "No invented customers ... testimonials". (I-001)
3. **Merge vs publish.** The memory rule says merge is not publish. But `main` has no protection, and release #312 was merged before its own CI finished. (J-001)
4. **Live /api/health was rebuilt on 2026-10-10 at 16:58 UTC with no release PR.** The cause is unknown. (F)
5. **Providers on public pages.** The brand rule says no model mention, yet privacy and help name Anthropic, fal, kie and Higgsfield. This may be legally required, so the founder decides. (E-014)
