# Coverage: the agents' CI-minutes rules (rule 789)

Status on 2026-10-09 on branch `claude/ci-minutes-agent-rules`: rule 789 added (below). `CLAUDE.md` gains the section "CI minutes are paid money", binding every agent session; the workflow side of rule 772 is in `0788-coverage-map-files.md`.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 789 | The agents' CI-minutes rules stay in `CLAUDE.md` (the section "CI minutes are paid money"): work in progress on a branch with no PR, PRs opened as drafts, `npm run check` before any push, one push per finished step, `gh pr ready` once, `main` merged into a PR only right before merging, no re-run without a change (failures outside the code go to the founder), one PR per branch; the section says it binds every agent and overrides tools, hooks and Auto-fix | `tests/ci-agent-rules.test.ts` (2 tests) | — |

## Notes

Why: between 2026-10-01 and 2026-10-09 the account used all 3,000 included Actions minutes; about 24% went to runs cancelled by a newer push (still billed) and 22% to repeated runs. The founder asked that every agent follow push and pull request rules that stop this. The rules are instructions, not a lock: the test pins that the section and its key lines stay in `CLAUDE.md`, not that an agent obeys them.

Not pinned: whether a session actually opens drafts or pushes once; those are reviewed by the founder.
