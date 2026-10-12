# 360 study, workstream J: process and delivery (2026-10-11)

Scope: recurring mistakes and their guards, CI minutes, session sprawl, memory drift. The Claude task ledger (section 6) is in `raw/J-claude-ledger-draft.md`. Findings are in `raw/findings-J.jsonl` (J-001 .. J-020). Verified against origin/main `3bf67673`, origin/production `487984f4`, `gh` (read-only) and local git, 2026-10-11 ~02:30 UTC.

## Summary

1. Of the five recurring mistakes, only CI minutes has a guard that is enforced in the repository (workflow scope, concurrency cancel, a test that pins the CLAUDE.md section). The other four rely on instructions or memory files that live outside the repo.
2. "Merging is not publishing" is guarded only by the memory note and by a GitHub ruleset that requires a PR into `production` with zero approvals. `main` has no protection and no required status check. Release PR #312 was merged before its own CI finished, after the memory rule existed.
3. Unpushed and unrecorded work is the main delivery risk: `claude/entitlements-part-b` (9 local commits, rules 790-802, tasks 1-6 of 9) and its ledger, which sits in a git-excluded folder inside another worktree. Memory describes it wrongly (7 commits, tasks 1-5).
4. Sprawl: 42 worktrees (34 fully merged), 210 local branches (104 merged and local only), 106 remote branches whose PR is merged or closed, 168 sessions (116 not archived).
5. CI minutes improved after rule 789: cancelled share of wall-clock minutes 38% (10-04), 27% (10-08), 9% (10-09), 1% (10-10).

## Current state

### Recurring mistakes vs guards (from journey log Appendix C)

| Mistake | Guard today | Where it lives | Enforced by code? | Verdict |
|---|---|---|---|---|
| L1 Merge is not publish, "yes" is not approval | Memory `feedback-no-production-without-explicit-approval`; ruleset "production: release PRs only" (PR required, 0 approvals, merge method merge, no bypass actors); `flows.md` section 52 (stale, see J-002) | Memory is per machine, outside the repo. CLAUDE.md has no such rule | Partly: production needs a PR, but anyone with write access can merge it. `main`: only the ruleset "NASHR" (no deletion, no force push, Copilot review); no required checks | Weak. VERIFIED by `gh api` rulesets and branch-protection 404 |
| L2 Secrets in chat, screenshots, commits | CLAUDE.md "Secrets..." line; `.gitignore` has `.env*`, `e2e/.auth/`; memory working-style note; `tests/secret.test.ts` pins `sameSecret` only | CLAUDE.md, .gitignore | No scanner: no gitleaks step in `ci.yml`, no hook; repo `security_and_analysis` returned null (secret scanning state UNVERIFIED) | Weak. My pattern scan of tracked files found no key-shaped strings (VERIFIED, limited patterns) |
| L3 CI minutes | CLAUDE.md section "CI minutes are paid money" (rules 772, 789); `ci.yml`: concurrency cancel-in-progress, draft PRs skip e2e, docs-only PRs skip build, push to main runs unit tests only; `tests/ci-agent-rules.test.ts`, `tests/ci-workflow.test.ts` | Repo | Workflow side yes. Agent side is text only (the test pins that the text stays, not that agents obey; its own notes say so) | Good. Text still mentions Vercel previews (J-006) |
| L4 Unchecked claims | CLAUDE.md "verify on production after the push"; memory deploy-verification note; `tests/docs-rule-numbers.test.ts` (duplicate rule numbers in tests.md only); `tests/content-claims.test.ts` (blog rubric) | Mixed | No test checks docs status lines or paths. `flows.md` section 52 and three memory lines are wrong today | Weak |
| L5 Shipped but not working | Rule per defect plus test (e.g. rule 904 for the 0.0.0.0 redirect), smoke/probe scripts | Repo | Tests yes. The `/p/` bug is on main but not live (no release PR yet) | Fine on the code side; delivery gap is the release |
| L6 Branch and PR hygiene | Rule 788 (one file per change in `docs/system/tests/`), rule 789 (one PR per branch, `gh pr list --head`) | Repo | Text; no `delete_branch_on_merge` | Partly. 106 stale remote branches |
| L7 Invented claims | CLAUDE.md "No invented customers..." | Repo | `content-claims.test.ts` covers one article only | Text only |
| L8 Security found after shipping | Tenant isolation, rate limits, `safeFetch` rules in CLAUDE.md, many tests | Repo | Yes (763 of 823 coverage rows name a test) | Good |
| L9 Wasted effort | Memory model-routing note; cost discipline in master prompt | Memory | No | Process only |

### CI minutes, last 7 days (runs created 2026-10-04 .. 2026-10-10, `gh run list`, 324 runs)

| Result | Runs | Wall-clock minutes (started to updated) |
|---|---|---|
| success | 132 | 1846 |
| cancelled | 55 | 491 (19% of 2554) |
| failure | 19 | 216 |
| startup_failure | 118 | about 0 (10-05: 2, 10-08: 116, the Actions budget block) |

Per day (created date): 10-04: 24 runs, cancelled 38% of minutes. 10-05: 46 runs, 13%. 10-08: 185 runs (116 startup failures), 27%. 10-09: 46 runs, 9%. 10-10: 23 runs, 1%. No runs are listed for 10-06 and 10-07 (cause unknown). Events: 217 pull_request, 106 push, 1 schedule. Minutes are wall-clock, not the billed figure; billed minutes are UNVERIFIED (no billing API access). Rule 789 merged 2026-10-09 19:22 UTC.

### Sprawl

| Item | Count | Detail |
|---|---|---|
| Worktrees (`git worktree list`) | 42 | 1 root checkout (on `fix/honest-claims`, 3 untracked `.claude/settings*` files), 40 under `.claude/worktrees`, 1 detached in a session scratchpad (`pr298`). 34 fully merged into origin/main. 8 hold unmerged commits. 19 are `wf_*` workflow leftovers from 10-01/10-02 |
| Dirty worktrees | 6 | `wf_1af850d7-76a-1` (89 staged files), `wf_1af850d7-76a-2` (64 staged), `chat-sessions-nashr-logs-2cc0f0` (PRD edit, superseded by main v3.2 section 11.10), root checkout, coordinator and 360-review (untracked `docs/prompts/`) |
| Local branches | 210 | 107 not on origin; 104 of those are fully in main; 3 are unpublished report branches with unique work (`journey-log-0111b9`, `leftovers-audit-360-341a20`, `supastarter-uiux-report-fca589`) |
| Local ahead of origin | 4 | `entitlements-part-b`, `ai-api-task-assignment-834d4f` (superseded by #310), `reem-b3-calendars` (merged via #314), `uiux-phase0` (1 renumber commit) |
| Remote branches | 113 | 4 with open PRs, 106 whose PR is merged or closed (repo setting `delete_branch_on_merge` is false), 1 closed unmerged (#295 festive-lovelace, superseded by #296) |
| Sessions (`list_sessions`, incl. archived) | 168 | 116 not archived; 105 of those without PR; 7 with a merged PR still not archived; 17 with a missing working folder; 96 idle more than 3 days. 78 sessions have a Nashr working folder, 27 of them not archived. The rest are unrelated projects |

### Memory drift (MEMORY.md and linked files vs git)

| Claim | Fact | Label |
|---|---|---|
| `nashr-local-checks`: 790-808 "unpushed local branch, 7 commits, tasks 1-5 of 9" | 9 commits ahead of main, rules 790-802, ledger says tasks 1-5 reviewed clean, task 6 implemented with fix round 1 awaiting re-review, task 7 brief written, 7-9 not built | STALE |
| `nashr-local-checks` and `straitly-model-routing`: "follow-up task_8d575e38" open | Started as session "Model routing follow-ups after #298" (archived), shipped as PR #315 (rules 905-907) | STALE |
| `nashr-local-checks`: "#320 991-1015 reserved, free 1016+" | PR #320 title now says 991-1010 | STALE (minor) |
| Same line: "#317 960-969 + 974-977" | Pushed `claude/uiux-phase0` still defines rows 970-973 in `docs/system/tests/0960-uiux-phase0.md`; the renumber commit `d6307768` is local only. Main has 970-972 (`0970-remove-pre-5-5-models.md`) | STALE on origin, correct locally |
| Master prompt: "staging.thakeen.com (lock on, Redis missing)" | Coordinator curl: 404 | STALE / UNVERIFIED |
| `thakeen-staging-release-flow` and `flows.md` section 52 | Section 52 still says production branch does not exist and merges to main reach customers | STALE (repo doc) |
| `admin-shell-brand-workspaces`: "own shell LIVE (#304 via #312)" | #304 is an ancestor of origin/production | VERIFIED |
| `straitly-model-routing`: "#298 merged ae3b32da, NOT live" | ae3b32da in main, not in production | VERIFIED |
| `chat-sonnet-55-paused`: #252 merged | Merged 2026-10-05 08:28 UTC; `CLAUDE_PAUSED = false` (brief) | VERIFIED (file name misleading) |
| `supastarter-eval`: #279, #280, #283 merged | All merged 2026-10-08 | VERIFIED |
| `composio-connectors`: #272 and #281 merged 2026-10-08 | Both merged 2026-10-08 | VERIFIED |
| `audit-leftovers`: "main about 77 commits ahead of production" | 77 | VERIFIED |
| No memory file for entitlements Part A (#299) or agent scope Part B | Only buried in `nashr-local-checks` | GAP |
| `thakeen-hostinger-deploy`: 11 env vars, 9 crons verified 200 | Not checkable read-only | UNVERIFIED |

## Findings (P0 first; none rated P0 in this workstream)

P1
- J-001 Merge is not publish: guard lives in memory only; `main` unprotected; production ruleset has 0 required approvals; release #312 merged before CI finished.
- J-002 `flows.md` section 52 status line is false (says merging to main reaches customers).
- J-003 Agent scope Part B: 9 unpushed commits and an SDD ledger that exists only on one laptop folder, git-excluded. Branch conflicts with main in 3 test files (`client-bundle`, `model-route`, `pricing-floor`).
- J-004 Secrets: no scanner, GitHub secret scanning status unverified.
- J-005 #317 on origin collides with main on rules 970-972; fix commit not pushed.
- J-006 Worktree sprawl, J-007 session sprawl (see tables).
- J-008 No check that docs status lines and memory match git (claims guard is weak).

P2: J-009 .. J-020 in the jsonl (CI minutes trend, Vercel text in CLAUDE.md and ci.yml, local and remote branch cleanup, unpublished report branches, plan checkboxes never ticked, memory edits, unpinned rules, dangling coverage refs, main checkout on a 3-week-old branch, `.claude/settings*` untracked in root).

## What could not be verified and why

- Billed Actions minutes and the remaining quota: no billing API read in this study. Wall-clock minutes are an approximation.
- GitHub secret scanning and push protection: `security_and_analysis` is null in the API reply (private repo, permissions unknown). Founder must read it in repository settings.
- Whether task 6 re-review of agent scope passed: the ledger ends at "re-review dispatched".
- Whether Claude Code hooks (GateGuard etc.) guard any of the five mistakes: user-level settings are outside this study and unreadable.
- Why no CI runs appear on 10-06 and 10-07.
- Hostinger-side facts (crons, env vars, staging) are not readable read-only.
- Session list may include non-Nashr sessions; counts of "Nashr" sessions use the working folder path only.
