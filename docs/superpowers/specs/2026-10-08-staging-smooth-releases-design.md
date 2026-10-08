# Staging and smooth releases: staging.thakeen.com and a `production` branch

Status: draft for the founder's review, 2026-10-08. Approach A of three (B: Vercel previews as staging; C: a VPS with blue-green switching), chosen by the founder the same day. C stays possible later; nothing here blocks it.

## 1. Goal and what the founder decided

Updates reach thakeen.com without customers seeing errors or a dead site, and every update is first tried on a copy that behaves like the live site.

Decided by the founder on 2026-10-08:

- **A staging site on the same Hostinger plan**, staging.thakeen.com, built from `main` the same way the live site is built.
- **Staging is locked.** Only people who typed the access code once can open it; everyone else gets 404. The founder first picked "secret link"; a secret in a URL breaks the project rule "secrets never in URLs", so the code is typed on a page instead (section 5.3). Same effect, rule kept.
- **Staging calls the real model** with its own Anthropic key and a low monthly spend limit set in the Anthropic console.
- **Going live is a release pull request `main` → `production` that the founder merges.** That click is the only path to the live site. Merging to `main` never reaches customers again.

Not in this spec: a VPS, two app copies switched behind a proxy, multi-region, copying customer data into staging, a feature-flag system, CI running on Hostinger.

## 2. How releases work today (checked 2026-10-08)

- thakeen.com is one Node.js app on Hostinger Business shared hosting (user `u472843410`), Git auto-deploy on `main`, build script `build:hostinger` (`next build --webpack`), Node 22.
- Every push to `main` starts a live build. The two builds of 2026-10-08 took about 2 minutes each (09:23:44 → 09:25:45 and 09:27:38 → 09:29:37 UTC).
- Nothing tests a change before it is live. GitHub Actions has not run since 2026-10-05 (billing), and the Vercel preview builds with Turbopack on Vercel, not webpack on Hostinger, so a green preview does not prove the Hostinger build.
- Hostinger's documentation says a successful build "re-points the `hbuilds/current` symlink": the old version serves until the new one is ready, then traffic moves in one step. Not documented: how long the app restart after the switch takes, and whether requests in flight (a streaming chat answer, a cron run of up to 310 s) survive it. Section 8 measures both.
- No rollback button. The documented way back is "revert or reset in Git and push", which is one more build of about 2 minutes.
- The Business plan includes 5 Node.js web apps; one is used. Staging costs nothing extra on hosting.

The larger risk of a "dropped site" is an untested change going live, not the switch itself. The staging site and the release pull request remove that risk; sections 5.5, 5.6, 5.9 and 6 shorten the switch and make it visible.

## 3. Release flow

```
feature branch ──PR──▶ main ──auto──▶ staging.thakeen.com   (checks, section 7)
                                │
                     release PR main → production (founder merges)
                                │
                          production ──auto──▶ thakeen.com
```

- **`production`** is a new long-lived branch. It is created at the commit live today (`02934d2`), so switching the live site's auto-deploy to it changes nothing customers see. Nothing is pushed to `production` except through a merged pull request.
- **Release pull request.** Opened by Claude from `main` (or from a tested commit of `main`) into `production`. Its description lists the merged pull requests since the last release, the staging commit that passed, the smoke results (section 7), whether stored data changes shape (section 6.3) and whether any environment variable changes (section 6.4). The founder merges it in GitHub with **"Create a merge commit"**, never squash or rebase: a squashed release gives `production` commits `main` does not have, and every later release pull request then conflicts. Claude never merges it and never pushes to `production`.
- **Hotfix.** The same path, only faster: fix on a branch → `main` → staging check → release pull request. About 5 minutes from merge to live. No shortcut around staging.
- If the GitHub plan allows a branch rule on a private repository, `production` gets one (pull requests only, no force push, no deletion). If it does not, the rule is the convention above plus this spec.

## 4. The staging site

### 4.1 Host

A second Node.js web app on the same Hostinger order, domain `staging.thakeen.com`, Git auto-deploy on `main`, the same build settings as live (`app_type` next, `build:hostinger`, Node 22, npm, output `.next`). Section 12 lists what must be checked first (a subdomain as its own Node.js app). DNS for `staging` points where Hostinger says.

### 4.2 Environment variables (entered by the founder in hPanel; never in chat, never committed)

| Name | Staging value | Why |
|---|---|---|
| `APP_ENV` | `staging` | `isProductionDeploy()` counts any value other than `test`, `development` and `preview` as production, so staging keeps rules 430 and 431 (never the memory store, never the model mock). Staging fails closed like the live site. |
| `STAGING_ACCESS_KEY` | a long random code the founder makes | The lock (section 5.3). |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | a new, empty Upstash database | No shared data with the live site, no customer data. |
| `ANTHROPIC_API_KEY` | a new key with a low monthly limit | Real chat and agents, bounded cost, spend visible apart from live. |
| `CRON_SECRET` | a new value | A staging secret can never call a live cron. |
| `APP_ORIGIN` | `https://staging.thakeen.com` | Links, robots, OAuth issuer. |
| Every other secret in `docs/system/variables.md` (`CONNECT_SECRET` and the rest) | new values | Nothing signed or encrypted on staging is valid on live. |
| `RESEND_API_KEY`, `MAIL_FROM` | unset | `mailReady()` is false: staging sends no email. |
| Payment, connector and media provider credentials | unset | No real money, no customer accounts linked. Added one by one, as test credentials, only when a change needs them. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | unset at first | Unset means not checked (`verifyTurnstile` answers "ok"); the lock already keeps strangers out. |

The authoritative list is `docs/system/variables.md`; the founder copies every name from the live app and gives each its staging value from this table.

### 4.3 Data

The staging database starts empty. Claude creates test accounts on staging only, with values recorded in a gitignored local file, never in chat. Customer data is never copied into staging.

### 4.4 Crons

None scheduled on staging. When a release touches a cron, Claude calls that one route by hand on staging (bearer `CRON_SECRET`, plus the access cookie).

### 4.5 Search engines

Staging is never indexed: `robots.txt` disallows everything, the sitemap is empty, and every response carries `X-Robots-Tag: noindex, nofollow` (section 5.3).

## 5. Code changes

Each unit has one job and can be tested alone.

### 5.1 `isStaging()` in `src/lib/deploy-env.ts`

`process.env.APP_ENV === "staging"`. The one question "is this the staging site", read by the lock, robots, sitemap and the access route. It does not change `isProductionDeploy()`: staging stays production for rules 430 and 431.

### 5.2 `sameSecret` in a dependency-free module

`src/lib/rate.ts` imports `db`, and the proxy must not pull Redis in. `sameSecret` moves unchanged to `src/lib/secret.ts` (imports only `crypto`); `rate.ts` re-exports it so no other import changes.

### 5.3 The lock: `src/lib/staging-access.ts` and `src/proxy.ts`

- `src/lib/staging-access.ts`: the cookie name `thakeen_staging`, and `accessToken(key)` = HMAC-SHA256 of the fixed label `staging-access-v1` keyed by `STAGING_ACCESS_KEY`, hex. The cookie holds this token, never the code itself. `hasAccess(cookieValue)` compares it with `sameSecret`. Changing `STAGING_ACCESS_KEY` signs everyone out.
- `src/proxy.ts`: the matcher widens from `["/", "/:lang/app/:path*"]` to every path except `_next/static`, `_next/image` and `favicon.ico`. When `isStaging()` is false the proxy does exactly what it does today, plus an early `NextResponse.next()` for paths it used not to see. When `isStaging()` is true:
  - The access page (`/ar/staging-access`, `/en/staging-access`), `POST /api/staging-access` and `/robots.txt` pass. `robots.txt` stays open because a crawler reads a 404 robots file as "everything allowed"; on staging it says `Disallow: /` (section 5.7).
  - Any other request without a valid cookie gets a bare 404 (no page, no hint that a site exists).
  - Every response gets `X-Robots-Tag: noindex, nofollow`.
  - `STAGING_ACCESS_KEY` missing or empty means nobody gets in (fail closed).

### 5.4 The access page and route

- `src/app/[lang]/staging-access/page.tsx`: one field and one button. 404 unless `isStaging()`. Arabic and English like every page.
- `POST /api/staging-access`: 404 unless `isStaging()`. Rate limit `allow("stagingaccess:" + clientIp(req), 5, 900)`. The code comes in the form body, never the URL. Right code: `Set-Cookie` with the token, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days, then 303 to `/ar`. Wrong code: 303 back to the page with `?e=1`. The code is never logged.

### 5.5 `GET /api/health`

- Public, no session. Rate limit 60 per minute per IP (`allow`). If the limiter itself fails (Redis down), the route still answers: it reads nothing else, and its job is to say the process is up.
- Answers `{ "ok": true, "commit": "<sha or unknown>", "built": "<ISO time>" }` with `Cache-Control: no-store`. Nothing else: no environment names, no Redis status, no dependency versions.
- On staging it sits behind the lock like everything else; the scripts send the cookie.

### 5.6 Build identity in `next.config.ts`

`env.BUILD_COMMIT` = `process.env.BUILD_COMMIT`, else `git rev-parse HEAD` at build time, else `unknown`; `env.BUILD_TIME` = the build's start time. Wrapped so a missing `git` never fails the build. Hostinger clones the repository, so `git` is expected to work; section 8 checks it. `BUILD_TIME` alone still tells two builds apart. If the build area has no `.git`, `commit` is `unknown`; a fixed `BUILD_COMMIT` in hPanel is no fallback, because it would be reported for every build. Then the build record is the source of the sha: `hosting_nodejs_list-builds` and `hosting_nodejs_build` carry the built commit at `options.source_options.commit.hash`, and 6.2 and 7 verify against it.

### 5.7 Robots and sitemap

`src/app/robots.ts`: on staging, `disallow: "/"` for every agent and no sitemap line. `src/app/sitemap.ts`: on staging, an empty list.

### 5.8 Scripts

- `scripts/probe.mjs <origin> <seconds>`: one `GET /api/health` every 1.2 seconds (50 a minute; one a second is 60, exactly the route's cap of 5.5, so any other caller on the same client address would push it to 429); prints each status change and commit change with a timestamp; ends with the longest run of failed requests, the slowest answer, the moment the commit changed and how many answers were throttled. A 429 is the route's limiter answering, so the process is up: it is counted apart (`throttled`) and is not a failure. Reads the access code from `STAGING_ACCESS_CODE` in the environment and never prints it.
- `scripts/smoke.mjs <origin>`: the checks of section 7, exit code 0 or 1, one line per check. On the live site it runs only the anonymous checks; sign-in and chat run on staging only, with the test account from section 4.3. Its `/api/health` check waits for `Retry-After` on a 429 and retries once. Neither script is relied on before the client-address check of `docs/system/flows.md` section 49, item 7 passes: if the host forwards no client address, every caller shares one health bucket of 60 a minute.

### 5.9 A chat answer cut by the switch

`/api/chat` streams status events, then the message and what it charged (`runChatTurn`). If the process restarts mid-turn the browser loses the stream. To check before changing anything: what `ChatPanel` shows when the stream breaks, whether the typed text survives, and whether a turn killed before `runChatTurn` returns can have charged credits. Fix only what turns out broken: keep the text, show a "connection lost, send again" line, never charge a turn that returned nothing.

## 6. Releasing and rolling back

### 6.1 When

- A release starts at night in Saudi Arabia, between 22:00 and 00:50 UTC (01:00 to 03:50 Riyadh), unless the live site is broken.
- Not within 10 minutes of a cron in `vercel.json`'s schedules, and at minutes :05 to :10, :20 to :25, :35 to :40 or :50 to :55, so the roughly 2-minute build finishes before the next quarter-hour secretary cron.
- After the switch, Claude calls `/ar`, `/en`, `/ar/app` and `/api/health` once each to warm the new process before customers do.

### 6.2 Verifying a release

`/api/health` on thakeen.com shows the release commit (while `commit` is `unknown`: `built` is later than before and the completed build whose `options.source_options.commit.hash` is the release commit, read with `hosting_nodejs_list-builds`). Then `scripts/smoke.mjs https://thakeen.com` passes. Then Claude tags the `production` commit `live-YYYY-MM-DD-N` and pushes the tag (section 12: a tag push must not start a build). A wrong commit in `/api/health` after 10 minutes means the build failed or is stuck: read `hosting_nodejs_list-builds`, then the build log.

### 6.3 Data that changes shape (new rule)

For a few seconds two versions may run, and a rollback runs old code on new data. So every change to a stored shape (a Redis key, a field, a JSON layout) goes out in two releases:

1. **Expand.** The new code reads the old and the new shape and writes the new one. Old code must still read what the new code writes, or ignore it safely.
2. **Contract.** Only in a later release, once rollback past the expand release is no longer wanted, the old reading goes.

A release pull request that changes a stored shape says so and names its step. A one-time conversion of existing data is an idempotent script run after the expand release is live, never at build time.

### 6.4 Environment variables

A variable changes on staging first. On the live site a change needs a rebuild, so it counts as a release: it goes in a release pull request's description and the rebuild is done in the window of 6.1.

### 6.5 Rollback

A revert pull request into `production` (reverting the release merge), opened by Claude and merged by the founder. Live again on the old code about 2 to 3 minutes after the merge. The release tags make the "last good" commit obvious.

Git trap: once a merge is reverted, merging the same commits again adds nothing back. So right after a rollback Claude brings the revert into `main` (a pull request `production` → `main`, merged by the founder), and the fix on `main` starts by reverting that revert. The fixed change then comes forward through staging and a normal release pull request.

## 7. What "passed staging" means

All of these, written into the release pull request:

1. `npm run check` and `npx next build` pass locally on the release commit.
2. The staging build of that commit completed (`hosting_nodejs_list-builds`), and staging's `/api/health` shows the commit (or, while `commit` is `unknown`, the build record's `options.source_options.commit.hash` is that commit).
3. `scripts/smoke.mjs https://staging.thakeen.com` passes:
   - `/` 307 to `/ar`; `/ar` and `/en` 200; `/robots.txt` disallows everything (staging) or matches today's file (live).
   - `/api/tasks` without a session 401.
   - Sign in with the staging test account; the app home renders.
   - One chat message gets an answer (staging only; real model, staging key).
   - One cron route by hand with the staging `CRON_SECRET` answers 200 (staging only).
4. Any page or flow the release changes, opened by hand on staging.

When GitHub Actions runs again (the founder fixes billing), `ci.yml` also runs on pull requests into `production`, and a red run blocks the release.

## 8. Step 0: measure before building more

Before the first release, on staging:

- Run `scripts/probe.mjs https://staging.thakeen.com 300` while staging rebuilds. Record: failed requests in a row, the slowest answer, when the commit changed, and how many answers were throttled.
- Start a build of a throwaway branch whose build fails, through `hosting_nodejs_start-build` on the staging app (a build started through the API does not change stored settings once they exist). Confirm staging keeps serving the old commit.
- Confirm `BUILD_COMMIT` is a real sha, not `unknown`, by comparing it with the build record's `options.source_options.commit.hash`. If it is `unknown`, `.git` is not in the build area and the build record stands in for it in 6.2 and 7.

If the gap is zero or a second or two, sections 5 and 6 are enough. If it is longer, the founder decides between living with it in the night window and moving to approach C.

## 9. Rules and tests

New rules, pinned in `docs/system/tests.md` (674 onward: 663 to 673 are taken by the Composio social results on `claude/composio-api-install-1d5bfc`; recheck before the code pull request):

- **674** Staging lock: with `APP_ENV=staging`, every path but the access page and route answers 404 without a valid cookie; with `STAGING_ACCESS_KEY` missing nobody gets in; with `APP_ENV` unset or `production` the proxy behaves as before. `tests/staging.test.ts`.
- **675** Access route: 404 off staging; rate-limited; compares with `sameSecret`; the cookie holds the HMAC token, never the code; the cookie is `HttpOnly`, `Secure`, `SameSite=Lax`; the code is never read from the URL. `tests/staging.test.ts`.
- **676** Health route: no session needed; rate-limited; the body has exactly `ok`, `commit`, `built`; `Cache-Control: no-store`. `tests/health.test.ts`.
- **677** Staging is never indexed: robots disallows everything, the sitemap is empty, `X-Robots-Tag` on every response. `tests/staging.test.ts`.
- **678** `APP_ENV=staging` is production for rules 430 and 431. Added to `tests/launch-security.test.ts`.
- **679** Expand and contract for stored shapes (section 6.3). A process rule; listed in `tests.md` as not pinned.

`tests/route-exports.test.ts` walks every route module, so the two new routes are held to handlers and segment config only with no change to it.

## 10. Documents to update in the same pull request

- `docs/system/architecture.md`: the two environments, the release flow, the new lib modules, the proxy's wider matcher.
- `docs/system/flows.md`: release, rollback, staging access.
- `docs/system/permissions.md`: `/api/health` (public) and `/api/staging-access` (staging only, public, rate-limited).
- `docs/system/variables.md`: `APP_ENV=staging`, `STAGING_ACCESS_KEY`, `BUILD_COMMIT`, `BUILD_TIME`, and the staging column of 4.2.
- `docs/system/tests.md`: rules 674 to 679.

## 11. Order of work and approvals

Each step that changes something outside the repository is done only after the founder says yes to that step.

1. **Founder:** creates the second Upstash database and the capped Anthropic key, makes the `STAGING_ACCESS_KEY` code. Fixing GitHub billing helps but does not block.
2. **Claude, read-only first:** confirms on the Hostinger API that a subdomain can be its own Node.js app on this order, and how its environment variables are set.
3. **Claude, needs approval (touches the live site's settings, not its code):** creates `production` at the live commit, then switches thakeen.com's Git auto-deploy from `main` to `production`. No rebuild happens (saving these settings on a Node.js site does not build). After this, merging to `main` cannot reach customers.
4. **Claude, needs approval:** creates the staging app (`staging.thakeen.com`, auto-deploy on `main`).
5. **Founder:** enters staging's environment variables in hPanel (4.2).
6. **Claude:** the code pull request (sections 5, 9, 10) into `main`. The founder reviews and merges; it builds staging only.
7. **Claude:** step 0 (section 8) and the smoke run on staging; report to the founder.
8. **Claude:** the first release pull request; the founder merges in the window of 6.1; Claude verifies (6.2) and tags.

## 12. To verify (facts, not decisions)

- A subdomain of `thakeen.com` as a separate Node.js web app on order 1009870060, with its own environment variables and Git settings.
- `git` is available during the Hostinger build (for `BUILD_COMMIT`); if not, the build record's commit hash stands in (5.6).
- Hostinger forwards a client address header (`x-real-ip` or `x-forwarded-for`). Without one, `clientIp` is the shared `unknown` for every public rate limit, the 60-a-minute health bucket included (`docs/system/flows.md` section 49, item 7).
- A pushed tag does not start a Hostinger build.
- A failed build leaves the previous build serving.
- The restart gap after a successful switch (section 8).
- Whether hPanel crons on the live site exist yet when the first release goes out (6.1 assumes the schedules in `vercel.json` plus the quarter-hour secretary cron).

## 13. Cost

Hosting: none (second of five included Node.js apps). Upstash: a second free-tier database. Anthropic: the staging key's monthly limit, set by the founder.
