---
name: release-and-env-vars
description: Use when shipping to thakeen.com (release PR from main to production, staging, smoke, tag, rollback) or when adding, renaming or removing an environment variable.
---

# Release and environment variables

Read `docs/system/flows.md` section 52 ("Releases") and `docs/release/rollback.md`. Never merge to `production` without the founder's ask in chat; never paste a variable value anywhere.

## How code reaches the site

1. Feature branch, pull request into `main`. staging.thakeen.com builds from `main`.
2. A release PR `main` into `production` (merge commit, never squash). thakeen.com on Hostinger deploys from the `production` branch.
3. The release PR description has five fields: PRs since the last release, the staging commit that passed, smoke results, the stored-shape step (expand, contract or none, see change-a-stored-shape), and environment variable changes by name only.
4. Smoke and probe scripts: `scripts/smoke.mjs` and `scripts/probe.mjs`. Their inputs (`STAGING_ACCESS_CODE`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`, `SMOKE_CRON_SECRET`) come from the environment or a local `.smoke.local` file that is never committed. Names are listed in `docs/system/variables.md` section 7.
5. After the merge: warm up the site, check that `/api/health` shows the release commit, run the smoke script against live, then tag `live-YYYY-MM-DD-N` and push the tag (a tag push starts no build).
6. Night window is 22:00-00:40 UTC. The founder may waive it in chat. Before launch the founder has suspended the window; still verify and tag.
7. Rollback is a revert PR into `production`, then a PR `production` into `main` so the branches agree (`docs/release/rollback.md`).

## Environment variables

1. Names and meaning live in `docs/system/variables.md`. Sections: core, access, mail and media, billing links, Paymob, connectors, ops, push, summary, script inputs. Add the row in the right section, saying whether it is a secret.
2. `.env.example` lists names only, no values, and is held equal to the doc by `tests/*` (rule 1977). Update both together.
3. `src/lib/integration-status.ts` lists names for the admin status page; add yours if it is an integration switch.
4. Read variables in one place per feature, and fail closed: a missing secret turns the feature off, never opens it. Check live mode with `isProductionDeploy` in `src/lib/deploy-env.ts`. `APP_ENV=test` must never be set on staging or live.
5. Staging gets a new variable first. On live, adding or changing one counts as a release and goes in the release PR description. The founder enters values in hPanel; ask in chat, but never ask him to paste a value to you.
6. Secrets are compared with `sameSecret` (`src/lib/secret.ts`), never accepted in URLs, never logged, never put in a test fixture. Rotating a leaked secret is the founder's action: tell him which name, not what to type.
7. Crons: listed in `crons.json` and run as hPanel crons that send the cron bearer secret. A new cron route is `auth: "cron"` (add-an-api-route) and the schedule is added by the founder in hPanel.

## Checks before a release PR

`npm run check`, `npx next build` (use `npm run build:hostinger` if Turbopack hangs, see local-setup), staging smoke green, the five fields filled, no unrelated PR in the range.

## Traps

- Squash-merging a release: it breaks the `production` to `main` history.
- Pushing the release branch to see what CI says. Prove locally, push once (fix-a-red-ci-run).
- Putting a value in the PR body, a commit, a log line or chat. Names only.
- Retired Vercel project: while it is connected it still builds previews (100 a day); report limits to the founder.
- Expand and contract in the same release.
