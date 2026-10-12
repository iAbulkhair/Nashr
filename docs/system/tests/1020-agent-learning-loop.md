# Coverage: agent learning loop, agents propose and the founder approves (rules 1020-1049)

Status on 2026-10-11 on branch `claude/prompt-studio-specs`: design only, `docs/superpowers/specs/2026-10-11-agent-learning-loop-design.md`. Builds on draft PR #316 (rules 930-959) and assumes it merges first. No code yet, so every rule is designed and none is pinned. The last column names the test file each build phase (spec section 17, phases A-G) adds.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1020 | Prompt order and precedence lines follow D5; `for_you` no longer overrides `for_all_agents`; workspace never overrides platform | designed, not pinned | `tests/learn-loop.test.ts` |
| 1021 | Layer 3: `skills:plan:{plan}` / `skills:industry:{id}` keys only from enums; rendered between platform and workspace; one `mget` with the other layers | designed, not pinned | `tests/learn-loop.test.ts` |
| 1022 | `lock` is read and stored but no longer orders or marks items at render (expand) | designed, not pinned | `tests/learn-loop.test.ts` |
| 1023 | `PromptStamp.tier` and `ro`; old tasks read unchanged | designed, not pinned | `tests/learn-loop.test.ts` |
| 1024 | `lstat` counters incremented at judge and decision time from the task's own stamp; no tenant data in the key or the fields | designed, not pinned | `tests/learn-loop.test.ts` |
| 1025 | `ChatMsg.pb` set on new replies; thumbs counted per version; old messages ignored | designed, not pinned | `tests/learn-loop.test.ts` |
| 1026 | Accounts with `learning: false` and the golden account contribute no signal | designed, not pinned | `tests/learn-loop.test.ts` |
| 1027 | No tenant free text in the proposer prompt (source and fixture test: a planted sentence never appears in the request) | designed, not pinned | `tests/learn-loop.test.ts` |
| 1028 | `redactForLabels` removes URLs, emails, phones, handles, digits and the workspace's brand, product and city tokens | designed, not pinned | `tests/learn-loop.test.ts` |
| 1029 | Labels from the closed list only; unknown index or label is `other`; the label model's text is not stored | designed, not pinned | `tests/learn-loop.test.ts` |
| 1030 | K = 5 distinct workspaces before a label enters the prompt | designed, not pinned | `tests/learn-loop.test.ts` |
| 1031 | Cron auth with `sameSecret`; single-run lock; resume | designed, not pinned | `tests/learn-loop.test.ts` |
| 1032 | Budget checked before every model call; weekly and per-target caps; over-cap targets skipped | designed, not pinned | `tests/learn-loop.test.ts` |
| 1033 | Proposer and label calls metered as platform (`learn@nashr.internal`, kind `learn`); no import of credit modules | designed, not pinned | `tests/learn-loop.test.ts` |
| 1034 | Proposer answer validated against the schema; never layer 0, a workspace layer, the reviewer or the judge | designed, not pinned | `tests/learn-loop.test.ts` |
| 1035 | `after` and `reason` screened (#316 screen plus leak check); a flagged proposal cannot be approved until clean | designed, not pinned | `tests/learn-loop.test.ts` |
| 1036 | Diff computed in code; `baseHash` mismatch answers 409 `stale` | designed, not pinned | `tests/learn-loop.test.ts` |
| 1037 | Evidence locations held server-side; the route takes only id and n; account wipe removes them | designed, not pinned | `tests/learn-loop.test.ts` |
| 1038 | Approve, edit-approve, reject under a per-proposal lock, status precondition, reason on reject, `adminAudit` row | designed, not pinned | `tests/learn-loop.test.ts` |
| 1039 | No path from cron or watch to activate, rollout start or ramp (import and source tests) | designed, not pinned | `tests/learn-loop.test.ts` |
| 1040 | Golden check only with `confirm: true` and a fresh nonce; estimate returned before; candidate runs in `golden:abruns` only | designed, not pinned | `tests/learn-loop.test.ts` |
| 1041 | Baseline reuse only with same version, hashes and age under 7 days | designed, not pinned | `tests/learn-loop.test.ts` |
| 1042 | `playbookOverride` passed only by `golden.ts` | designed, not pinned | `tests/learn-loop.test.ts` |
| 1043 | Rollout start only on an approved proposal, with flag `learn_rollout` on; one per layer and per agent target; editor activation refused while running | designed, not pinned | `tests/learn-loop.test.ts` |
| 1044 | Bucketing deterministic, salt per rollout, monotonic in `pct`, null scope always control | designed, not pinned | `tests/learn-loop.test.ts` |
| 1045 | Watch: minimum sample, thresholds, rollback by clearing or restoring an older revision; never forward | designed, not pinned | `tests/learn-loop.test.ts` |
| 1046 | Finish makes the candidate active as a new revision with the proposal noted | designed, not pinned | `tests/learn-loop.test.ts` |
| 1047 | Base proposals write no prompt layer; Claude brief contains file, base hash and diff; `live` only when `playbookHash` equals `afterHash` | designed, not pinned | `tests/learn-loop.test.ts` |
| 1048 | Routes authenticate first; rate limits as section 13; no scope, email or key from the request | designed, not pinned | `tests/learn-loop.test.ts` |
| 1049 | Reserved for follow-ups | designed, not pinned | `tests/learn-loop.test.ts` |

## Not pinned

- All of 1020-1049: nothing is built. Each phase of spec section 17 pins its rules in `tests/learn-loop.test.ts` (source and fixture tests; the suite has no DOM) and moves its rows to pinned in the same change.
- 1020-1023 change #316's merge point (its rules 942, 946 and 947). They are built only after #316 is on main, and that change also updates #316's coverage rows.
- 1038 and 1043-1046 depend on `adminAudit` and the `learn_rollout` flag from the admin control center spec (rules 1066 and 1069), so that spec's phase 1 comes first.
- 1049 is reserved for follow-ups.
