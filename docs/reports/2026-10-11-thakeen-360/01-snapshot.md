# 01. Verified snapshot (2026-10-11, about 00:30 UTC)

Checked by the coordinator with `git fetch`, `gh` and `curl` against origin and the live sites. Each line of the master prompt's section 3 is listed with its verdict.

## Branches and releases

| Claim (2026-10-10 21:00) | Verdict | Evidence |
|---|---|---|
| Live is `production` at `487984f` (#312) | VERIFIED | `origin/production` = `487984f4`, "Merge pull request #312 (release/2026-10-09-2)", 2026-10-10 00:46 +03 |
| `main` at `3bf67673` (#318), 77 commits ahead | VERIFIED | `origin/main` = `3bf67673`; `git rev-list --count origin/production..origin/main` = 77 |
| Merged but not live: #298, #311, #313, #314, #315, #318 | VERIFIED | `gh pr view 298`: merged 2026-10-10 09:36 UTC (`ae3b32da`); #311 09:47, #313 10:34, #315 10:33, #314 11:34, #318 16:44 UTC; all after #312 (2026-10-09 21:46 UTC) |

## Live bug

| Claim | Verdict | Evidence |
|---|---|---|
| `thakeen.com/p/<code>` returns 307 to `https://0.0.0.0:3000/...`; fix #313 on main only | VERIFIED, still live | `curl -I https://thakeen.com/p/TEST123` → `307`, `location: https://0.0.0.0:3000/ar/app/signup`, server `hcdn` |

## Open drafts

| PR | Claim | Verdict | Evidence |
|---|---|---|---|
| #316 agent skills portal | rules 930-959, conflicts | VERIFIED | `mergeable: CONFLICTING`; 87 files; tests/0955, 0957, 0958 on the branch |
| #317 UI phase 0 | rules 960-969 + 974-977; only red check is old Vercel | VERIFIED | checks: Nashr CI SUCCESS, Vercel FAILURE, Vercel Preview Comments SUCCESS; `MERGEABLE` |
| #319 retire Vercel | rules 987-990 | VERIFIED | `tests/0987-retire-vercel.md` on branch; `MERGEABLE` |
| #320 media storage spec | rules 991-1015 reserved | STALE | PR title now says **rules 991-1010**; treat 1011-1015 as free only after checking the spec body |

## Rule numbers

| Claim | Verdict | Evidence |
|---|---|---|
| Free: 908-909, 924-929, 978-979, 1016+ | VERIFIED with a note | main uses 901-907, 910-923, 969-973, 980-986; drafts use 930-969, 974-977, 987-1010. 1011-1015 may also be free (see #320). Check `origin/main:docs/system/tests/` and open PR titles before taking a number |
| Unpushed work on `claude/entitlements-part-b`, 7 local commits (tasks 1-5 of 9, rules 790-808) | STALE in detail | local head `19fdf185`, origin head `2df00a84`; `git rev-list --left-right --count` = 0 behind / 127 ahead. 9 agent-scope commits (rules 790-802) sit on top; the rest is main merged in. See 04-J |

## Dormant features

| Feature | Verdict | Evidence |
|---|---|---|
| Paymob `PAYMOB_*` | see 04-G | |
| Composio `COMPOSIO_*` | see 04-H | |
| Reem calendars `GOOGLE_*`, `MICROSOFT_*` | see 04-H | merged in #314, not live |
| Straitly routing default off | see 04-D | merged #298, not live |

## Other settings

| Claim | Verdict | Evidence |
|---|---|---|
| `CLAUDE_PAUSED = false` | VERIFIED | `src/lib/model.ts:19` |
| Trial 3 days in code, PRD says 7 | see 04-A | |
| Only 5.5-family models | see 04-D | #308 + #318 (rules 809, 900, 970-972) on main; production has #308 only |

## Live sites

| Site | Verdict | Evidence |
|---|---|---|
| https://thakeen.com | up | `/` → 307 `/ar`; `/api/health` 200; server `hcdn` (Hostinger) |
| https://staging.thakeen.com | STALE ("lock on, Redis missing") | now **404** at `/`, server `hcdn`. See 04-F |
| https://nashr-tau.vercel.app | still serving | `/` → 307 `/ar`, server Vercel. Retirement (#319) not done |

## GitHub

- Open issues: 174 (VERIFIED, `gh issue list --state open`).
- Open PRs: exactly the 4 drafts above.
