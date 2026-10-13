# Rollback: put thakeen.com back on the previous release

Written 2026-10-12 (rules 1430-1435 batch, finding F-013). The process rule is `docs/system/flows.md` section 52, items 11 and 12; this file is the step-by-step. Nothing here was run against GitHub's `production` branch or the live site. The git part was rehearsed locally on 2026-10-12 (section 3).

thakeen.com builds from the `production` branch on Hostinger. Every release is a merge commit on `production`, tagged `live-YYYY-MM-DD-N` after it passed (flows.md 52, item 7). The `production` ruleset forbids force pushes and deletion and requires a pull request, so a rollback is always a new commit on `production` through a pull request: never a force push, never a reset.

## 1. Decide

- Roll back when the live site is broken by the release and a forward fix is not ready within the release window (flows.md 52, item 6). Outside the window, a broken live site is reason enough to start now.
- Find the last good tag: `git fetch origin --tags && git tag -l 'live-*' | sort | tail -3`. The previous release is the tag before the newest one.
- Data shape (rule 679): rolling back a contract release lands on its expand release, which still reads both shapes. Do not go further back than the expand release of any shape change since.

## 2. Path A: revert the release merge (the normal path)

For the newest release only. Claude, on a new branch from `origin/production`:

```bash
git fetch origin production --tags
git switch -c rollback/YYYY-MM-DD origin/production
git revert -m 1 --no-edit <release merge commit>
git diff --stat <previous live tag>
```

The last command must print nothing: the tree is now exactly the previous release. Then `npm run check` and `npx next build`, push the branch, open the pull request into `production` (`gh pr create --base production --draft`, then `gh pr ready`; the description names the release reverted and the tag it lands on). The founder merges it with "Create a merge commit". Hostinger builds it like any release (about 2 to 3 minutes).

## 3. Path B: restore the previous tag's tree

When more than one release must go, or `git revert` conflicts. It makes one commit on top of `production` whose files are exactly the tag's:

```bash
git fetch origin production --tags
git switch -c rollback/YYYY-MM-DD origin/production
git restore --source=<previous live tag> --staged --worktree -- .
git commit -m "Roll back to <previous live tag>"
git diff --stat <previous live tag>
```

Again the last command must print nothing. Same checks, same pull request, same merge as path A.

Rehearsed 2026-10-12, locally, with plumbing only (nothing pushed, no branch written): against `origin/production` at `487984f4` (release #312, tag `live-2026-10-09-2`), path A's revert of `487984f4` (`git merge-tree --write-tree --merge-base=487984f4 origin/production 487984f4^1`) and path B's commit of the `live-2026-10-09-1` tree on top of `production` (`git commit-tree`) both gave a tree with no difference from `live-2026-10-09-1`, and path B's commit is a fast-forward of `production`. Not rehearsed: the pull request, the merge and the Hostinger build of a rollback.

## 4. After the rollback

Claude, once the build has finished (flows.md 52, item 7):

- `GET https://thakeen.com/api/health` shows the commit of the rollback merge (or, while `commit` is `unknown`, a `built` time after the merge).
- `node scripts/smoke.mjs https://thakeen.com` passes.
- `GET https://thakeen.com/api/health?crons=1` with the cron bearer: Reem's tick (`secretary`) shows a run within 15 minutes after the build. If it does not, the founder reads the hPanel cron list (read-only): the tick must be a `POST /api/cron/secretary` with the bearer every 15 minutes (a `GET` answers 405). Since rule 1432 a bearer tick also marks timed reminders as running.
- Tag nothing: the old tag already names this code.
- Right after, Claude opens the pull request `production` to `main` that carries the revert into `main` (flows.md 52, item 12). The fix on `main` starts by reverting that revert.

## 5. Founder action: does the CDN purge on a new build? (F-023)

Not run. thakeen.com answered `cache-control: s-maxage=31536000` with `x-hcdn-cache-status: HIT` on 2026-10-11; whether a new build empties that cache is unknown. At the next release (or a rollback), with no extra build:

1. Before the merge, run each of these twice, a minute apart, and note the time:
   ```bash
   curl -sI https://thakeen.com/ar
   ```
   ```bash
   curl -sI https://thakeen.com/en/terms
   ```
   Record `age`, `etag`, `x-hcdn-cache-status` and `last-modified` for each. The second is a prerendered page few people open.
2. Merge. Wait until `/api/health` shows the new commit; note that time.
3. Run the same two requests again.
4. Read the result:
   - `age` smaller than the time since step 2, or a new `etag`: the CDN purged (or never kept the old copy). Record "purges on build" in `docs/system/flows.md` section 52.
   - `age` larger than the time since step 2 and the old `etag`: the CDN did not purge, and customers see the old page until it expires. Then the CDN cache is purged in hPanel after every release and rollback (added to section 4 here and to flows.md 52, item 7), and Claude looks at a shorter `s-maxage` for the HTML pages in a separate change.
5. Paste the `curl -sI` outputs (headers only, no cookies) into the release pull request.

## 6. Founder action: Hostinger's request time limit (B-004)

Not run. The routes declare `maxDuration` 60 to 300 seconds, which only Vercel reads; on Hostinger the real limit is whatever the CDN, LiteSpeed and the Node host allow, and nothing has measured it. On staging first, never on the live site without a separate yes:

1. A streamed chat answer: sign in on staging with a staging test account and ask Noor for a long piece (for example a full month plan), with the browser's network panel open. Note when the stream starts, when it ends, and whether it ended with the answer or was cut. Costs one chat turn on the staging Anthropic key (its own low limit).
2. Note the longest stream that finished, and whether any stopped at a round number of seconds (30, 60, 100, 120).
3. No route sleeps on purpose, so a request longer than a chat answer cannot be made without spending. If the founder wants the exact ceiling (for example one 120 s and one 280 s request), Claude adds a cron-bearer-only diagnostic route in its own pull request, runs it on staging, and removes it afterwards.
4. Claude records the measured limit in `docs/system/architecture.md` section 6 and lowers the deadlines (`deadlineFor`, `src/lib/media/keys.ts`) to fit it.

## 7. Not in place yet (F-013)

- The `production` ruleset has no required status check: a red CI does not technically stop a release merge. Adding the Nashr CI check as required is a GitHub setting the founder changes, once CI is stable.
- The restart gap (how long the site is down while the new build switches in) has not been measured; flows.md 52, item 8 runs `scripts/probe.mjs` on staging during a rebuild for that.
