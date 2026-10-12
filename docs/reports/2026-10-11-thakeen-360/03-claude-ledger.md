# Claude task ledger (2026-10-11)

What Claude still owes, from workstream J. Rows CL-001..CL-039 come from memory files, open PRs, local branches, the session list and the 2026-10-10 audits. Nothing here is started by this study. Each fix goes on its own branch with no push or merge until the founder says so (CLAUDE.md CI rules: draft PR only when done, one push per finished step).

## Top 5 now

1. Release R1 prep branch: heading copy per the founder decision (I-001), the hello@nashr.ai replacement (G-007), and a post-release smoke checklist. Waits on the founder's heading decision.
2. Finish #317 (founder console Cancel bug, E-001). Push the local renumber commit `d6307768` so rows 970-973 no longer collide with main (J-005). Run `npm run check` and `npx next build` first, then `gh pr ready` once.
3. Privacy and terms draft for the lawyer: entity name, cross-border transfer, current processors (Anthropic, fal, kie, Higgsfield, Straitly, Upstash, Resend, Hostinger) (C-002, C-009, D-005).
4. Production monitoring and a health check that touches Redis (F-004). Make the CI build match production: webpack on Node 22 (B-001).
5. Push `claude/entitlements-part-b` (9 local commits, rules 790-802) to its own branch, with no PR, after the founder's OK (J-003). Its SDD ledger sits in the git-excluded folder of worktree `thakeen-setup-configs-5ba1b2`, so copy it first.

## Housekeeping (needs the founder's OK; nothing deleted by this study)

- 34 of 42 worktrees are fully merged. `mcp__ccd_host__clean_up_worktrees` can remove them once the founder agrees.
- 104 local branches are merged and local only. 106 remote branches belong to merged or closed PRs; `delete_branch_on_merge` is false.
- 116 of 168 sessions are not archived.

---

The full ledger from workstream J follows.


Verified against origin/main `3bf67673`, origin/production `487984f4`, `gh` read-only, local git and the session list. Archive in the last column means "safe to remove once the founder says yes"; nothing was removed or changed in this study. Plan checkboxes are never ticked (0 of about 1000), so "state" comes from PRs, code and ledgers, not from checkboxes.

| id | item | source | state | next step | keep/merge/archive |
|---|---|---|---|---|---|
| CL-001 | Agent scope Part B (rules 790-808, plan 9 tasks) | `docs/superpowers/plans/2026-10-09-agent-scope-part-b.md`; local `claude/entitlements-part-b` 19fdf185; origin 2df00a84 (plan only); ledger `.superpowers/sdd/2026-10-09-agent-scope-part-b/progress.md` in worktree `thakeen-setup-configs-5ba1b2` | 9 local commits ahead of main (base 33974368, 42 behind). Tasks 1-5 done and reviewed clean. Task 6 implemented (c54a40f4) plus fix round 1 (19fdf185), re-review dispatched, result unknown. Task 7 brief written. Tasks 7 (publish check), 8 (labelled set, eval, modes route, founder panel), 9 (scans, privacy text, docs) not built. Three test files conflict with main | Push branch fast-forward (founder yes), back up ledger, finish T6 re-review and T7-T9, merge main only before the PR, draft PR at the end. Memory says 7 commits / tasks 1-5: stale | keep (merge later) |
| CL-002 | Brand limits per plan (Part B, rules 880-883) | `docs/superpowers/plans/2026-10-09-brand-limits.md`; spec `2026-10-09-admin-shell-and-brand-workspaces-design.md` part B | Not started. No `brandLimit` in `src/lib/entitlements.ts` or `pricing.ts` on main. Part A (#304) is live in production; #298 merged | Start when the founder asks; branch `claude/brand-limits` from main, draft PR; founder word needed before any release | keep (plan) |
| CL-003 | Draft PR #316, agent skills portal (rules 930-959) | PR #316, branch `claude/agent-skills-portal-47b7dd`, 28 commits ahead of main | Open draft, CONFLICTING (brief: `flows.md`, `judge.ts`, `media/prompts.ts`). Founder items open per memory | Merge main in right before merge, resolve the three conflicts, one push | keep |
| CL-004 | Draft PR #317, UI phase 0 (rules 960-969, 974-977) | PR #317; worktree `thakeen-setup-configs-5ba1b2`; session "UI Phase 0" | Open draft, MERGEABLE. Origin head still defines 970-973 (collides with main 970-972); renumber commit d6307768 is local only. Founder asked at 02:13 UTC to recheck for Vercel | Push the renumber once with the Vercel recheck | keep |
| CL-005 | Draft PR #319, retire old Vercel project (rules 987-990) | PR #319, branch `claude/retire-vercel` | Open draft; CLAUDE.md and ci.yml still carry Vercel wording | Include CLAUDE.md and ci.yml wording; founder dashboard steps are his | keep |
| CL-006 | Draft PR #320, media storage spec (rules 991-1010 per title) | PR #320, branch `claude/media-storage-spec-41fe7e`, 5 commits | Open draft spec; no implementation plan yet | Founder reads the spec; plan next | keep |
| CL-007 | Release PR main to production (77 commits waiting) | `git rev-list origin/production..origin/main` = 77; tag live-2026-10-09-2 | Waiting. Includes #313 (the `/p/` redirect fix; the bug is still live, brief) and #298, #314, #315, #318 | Founder decides; run staging smoke first if staging exists (it returns 404 now) | n/a |
| CL-008 | Reem B2b + B3 calendars | #314 merged 2026-10-10, not in production; plan `2026-10-05-reem-b3-calendar-read.md` | Merged, not live; cannot link until `GOOGLE_*` / `MICROSOFT_*` are set (memory, UNVERIFIED here) | Founder env vars and app approvals | n/a |
| CL-009 | Straitly model routing (rules 810-866, 902, 903) | #298 merged 2026-10-10, ae3b32da not in production | Merged, default off, not live. Open founder decision in the SDD ledger tail: Opus chat with full memory gets no answer for 6 of 8 agents under approved pricing (UNVERIFIED whether still open) | Release PR; founder decision | n/a |
| CL-010 | Composio, Meta, social results, social analytics | #272, #281, #300 merged 2026-10-08/09 | Merged and dormant until `COMPOSIO_*` is set in production | Founder env and app approvals | n/a |
| CL-011 | Paymob KSA billing | #279 merged, gated off | Dormant | Founder (MobPay, env) | n/a |
| CL-012 | Staging plan, ops tasks 10-15 | `docs/superpowers/plans/2026-10-08-staging-smooth-releases.md`; #282, #294 merged | Code done. staging.thakeen.com returns 404 (coordinator curl); memory says lock on | Founder or workstream D to confirm staging state | n/a |
| CL-013 | Store connectors spec (Salla, Zid, WooCommerce, WordPress) | `docs/superpowers/specs/2026-10-05-store-connectors-design.md`; #260, #261, #267, #269, #278 merged | WooCommerce snapshot and sync built; the rest of the spec is UNVERIFIED (not traced) | Trace spec sections against code | keep |
| CL-014 | Spec status lines stale | dictionary-onboarding (says draft, code is on main), pwa-install (says not merged, #280 merged) | Stale text | Fix in the next docs push | n/a |
| CL-015 | Plans with all boxes open | 20 plans in `docs/superpowers/plans/` | 0 ticked. Built per PR: homepage, reem 3a1/3a2/b1/b2/b3, reskin, meta-via-composio, social results, email verification, entitlements A, social analytics, staging code, straitly, admin shell. Not built: brand limits, agent scope T7-9 | Add a status line with PR number to each plan, or stop using checkboxes | n/a |
| CL-016 | Follow-up task_8d575e38 (model routing follow-ups after #298) | memory MEMORY.md line 28; session "Model routing follow-ups after #298" (archived), PR #315 | Done: wipeAccount race, brand lock 503, Premium hold shipped as rules 905-907. Memory still calls it open | Fix memory | archive (card) |
| CL-017 | Follow-up task_41ca0437 (proxy hardening) | session "Proxy hardening" (archived), PR #294 merged 2026-10-08 | Done | none | archive |
| CL-018 | Follow-up task_7a8c83b5 (PWA phase A) | session "Supastarter vs Thakeen UI/UX deep report"; PR #280 merged | Done | none | archive |
| CL-019 | Follow-up task_1ba3595c (rate-limit fix) | memory thakeen-staging-release-flow.md | UNVERIFIED: no matching session or PR title found | Search transcripts if it matters | unknown |
| CL-020 | Unpinned rules | `docs/system/tests.md`, `docs/system/tests/*.md` (823 rows, 763 name a test) | Rule 19 none (chat heartbeat and saved-reply recovery), 679 process, 853 and 865 not tested yet, about 45 "Not pinned" notes. Highest risk is rule 19 | Write the rule 19 test with a slow fake model | keep |
| CL-021 | TODO / FIXME markers | `git grep` over src, scripts, e2e, tests | Zero markers | none | n/a |
| CL-022 | SDD ledgers (git-excluded) | worktrees `thakeen-setup-configs` (agent scope, live), `claude-api-agents` (straitly, merged), `chat-sessions-nashr-logs` (reem 3a1, 3a2, merged), `cool-tu-144390` (homepage, reem b1, b2, merged) | Only the agent scope ledger describes unfinished work | Back up agent scope ledger; rest go with their worktrees | keep one, archive rest |
| CL-023 | Docs fixes: `flows.md` section 52 status, 2 dangling coverage refs, 8 unreferenced tests, CLAUDE.md Vercel wording | see findings J-002, J-010, J-017 | Open | One docs push, batched | n/a |
| CL-024 | Memory corrections and missing file | see report Memory drift table | Open | Edit memory files; add entitlements/agent-scope file | n/a |

### Worktrees (42) and local branches

| id | item | state | keep/merge/archive |
|---|---|---|---|
| CL-030 | `strange-kilby-e46c6b` (branch `claude/360-study-2026-10-11`, this study) | = origin/main, untracked `docs/prompts/` and reports | keep until the study is committed |
| CL-031 | `thakeen-arabic-word-search-1c99ad` (360 review session) | merged, untracked `docs/prompts/` copy | keep until the study ends, then archive |
| CL-032 | `laughing-elion-9449f8` (#316), `thakeen-setup-configs-5ba1b2` (#317, holds agent scope ledger), `happy-gould-4c332b` (#320), `anthropic-token-cost-calculation-3ec086` (#319) | open drafts | keep |
| CL-033 | `leftovers-audit-360-341a20`, `supastarter-uiux-report-fca589`, `journey-log-0111b9` (worktrees `leftovers-audit-360-341a20`, `staging-zero-downtime-updates-f99ead`, `supastarter-thakeen-adoption-55ec97`) | unique commits, not on origin, no PR | merge (as docs, one docs PR or push without PR) then archive |
| CL-034 | `claude/entitlements-part-b` (no worktree) | see CL-001 | keep, push |
| CL-035 | `chat-sessions-nashr-logs-2cc0f0` (branch `prd-file-dhakeen`, #265 merged; dirty PRD edit) | dirty edit superseded by origin/main PRD v3.2 section 11.10; holds finished Reem ledgers | archive |
| CL-036 | `wf_1af850d7-76a-1`, `wf_1af850d7-76a-2` | 89 and 64 staged files against an old HEAD (#233) | archive (discard the stale index; needs founder yes) |
| CL-037 | 17 other `wf_*` worktrees (10-01 and 10-02 workflow runs) | all fully merged, clean | archive |
| CL-038 | `claude-api-agents-2c7b35` (#298 merged), `stoic-merkle-725a1e` (#311), `vercel-necessity-review-6a1a3b`, `github-ci-red-button-e3c6b9`, `cool-tu-144390`, `recursing-jang-53fa53`, `reverent-agnesi-983c40`, `api-list-517da7`, `agent-ae1ec743ccab8dcc9`, `jev-thakeen-embedding-ccb68c`, `recursing-panini-ff53bc` | fully merged, clean | archive |
| CL-039 | `pr298` detached worktree in a session scratchpad | detached at a12f897d, in main | archive |
| CL-040 | Root checkout `/Users/ihejazy/projects/nashr` on `fix/honest-claims` | merged branch, 3 untracked `.claude/settings*` files (not opened) | founder decision |
| CL-041 | 104 local branches fully in main and not on origin | merged | archive |
| CL-042 | Local branches ahead of origin: `ai-api-task-assignment-834d4f` (rule 901, in main via #310), `reem-b3-calendars` (12 commits, merged via #314), `uiux-phase0` (1 commit, see CL-004) | first two merged | archive first two, keep third |
| CL-043 | `festive-lovelace-7b8c4c` (#295 closed, superseded by #296), `launch-topups`, `prd-file-dhakeen`, `fix/e2e-coverage-and-defects` (patches differ but PRs merged) | closed or merged by other SHAs | archive |
| CL-044 | 106 remote branches with merged or closed PRs | repo setting `delete_branch_on_merge` is false | archive after the founder turns on auto-delete |
