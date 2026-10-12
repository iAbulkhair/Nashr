# Coverage: the repository stops steering the old Vercel project (rules 987-990)

Status on 2026-10-10 on branch `claude/retire-vercel`. thakeen.com moved to Hostinger on 2026-10-08 (live from the `production` branch, staging from `main`). The old Vercel project, `nashr-tau.vercel.app` on the Hobby plan, which is for non-commercial use, still built every commit on `main` (its `/api/health` reported `main` 1fb56b90 on 2026-10-10 while live reported 487984f) and ran the `vercel.json` crons against its own Upstash database. This change removes what the repository gave that project. The founder still disconnects or deletes the project in the Vercel dashboard. Vercel runs the crons of its current production deployment, so the old crons stop only then.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 987 | `appOrigin()` falls back to `https://thakeen.com` when `APP_ORIGIN` is unset, empty or malformed. No file under `src/` names a `vercel.app` host, `src/lib/origin.ts` included | `tests/origin.test.ts` (rules 356-358 tests now expect `FALLBACK_ORIGIN` = `https://thakeen.com` and scan every file in `src/` with no exemption) | — |
| 988 | CI runs on pull requests only. No `push` trigger, no `github.event_name` branch in the workflow, no "Seed Playwright cache" step. The job is still named "Nashr CI" and always reports | `tests/ci-workflow.test.ts` (the `on:` block is exactly the `pull_request` trigger; the Scope script still runs for real in throwaway repositories; the Playwright steps follow Scope's `e2e` only) | — |
| 989 | The cron schedule is `crons.json` (`vercel.json` renamed, same entries). No host reads it; the hPanel cron jobs must match it. There is no `vercel.json`, nothing in `src/` names one, the list covers every GET route under `src/app/api/cron/` except Reem's POST tick, and every entry is a five-field schedule with a fixed minute and hour | `tests/retire-vercel.test.ts`; `tests/secretary-phase2.test.ts`, `tests/store-scheduled-sync.test.ts` `tests/handoff-auto.test.ts` and `tests/monitoring-ci-parity.test.ts` (rule 1014's heartbeat limits) read their entries from `crons.json` | — |
| 990 | Live moves from the `VERCEL_ENV=production` stopgap to `APP_ENV=production`. `variables.md` gives the founder the steps for hPanel, and `isProductionDeploy` keeps reading `VERCEL_ENV` until the founder has switched (expand, then contract) | `tests/retire-vercel.test.ts` (the `VERCEL_ENV` row names `APP_ENV=production` and hPanel; `deploy-env.ts` still reads `VERCEL_ENV=production`) | Contract step: once live runs on `APP_ENV`, remove the `VERCEL_ENV` readings and change `tests/launch-security.test.ts` to match |

## What a Playwright cache costs now

The push run on `main` used to seed the Playwright browser cache that every pull request could read. Without it, each pull request's first end-to-end run downloads the browsers (about 30 seconds), and that pull request's later runs restore them. Before, the push run on `main` cost a runner, `npm ci` and the unit tests on every merge.

## Not pinned

- The Vercel project itself: disconnecting it, turning off its Deployment Check and crons, and deleting its environment variables. These are dashboard actions for the founder.
- hPanel: that its cron jobs match `crons.json`, and the `APP_ENV` switch on live. Both are read-only checks against hPanel.
- The privacy policy (`src/lib/legal.ts`) and the help answer on deleting an account (`src/lib/help.ts`) name Vercel and Vercel Blob as infrastructure and do not name Hostinger. They are left unchanged: the privacy text is pinned by date (`tests/topup-refunds.test.ts`) and by the names it lists (`tests/content-claims.test.ts`), and the media store choice below changes the same sentences. They should be edited once, with that choice.

## Open: where generated media lives (founder's choice)

`src/lib/media/blob.ts` writes every provider result to Vercel Blob (`@vercel/blob` `put`, public store, `media/{32 hex}.jpg|.mp4`). `isOurBlobUrl` in `src/lib/media-catalog.ts` accepts only `*.public.blob.vercel-storage.com`, and that check decides what may go to a provider as a reference image, to Meta, and to Composio. The store has to stay public, because Meta fetches a post's image by URL with no credentials. Vercel Blob is the last Vercel service the product uses, and on the Hobby plan it cannot back a paid product. Prices below were checked on 2026-10-10. Confirm them before buying.

| Option | Cost | Effort | Notes |
|---|---|---|---|
| A. Cloudflare R2 (S3 API) with a custom domain such as `media.thakeen.com` | $0.015 per GB-month, $4.50 per million writes, $0.36 per million reads, no egress charge. Free each month: 10 GB, 1M writes, 10M reads. At launch scale this is likely $0 | About 1 day. Swap `put`/`del` for the S3 client (`@aws-sdk/client-s3`, or the smaller `aws4fetch`). `isOurBlobUrl` accepts our own media host, and during an expand step it also accepts the old Blob host, so existing posts keep working. Four new variables. The console probe is rewritten | Recommended. Public custom-domain bucket, no egress fees, and it does not depend on any web host. The old Blob files stay where they are until a copy script moves them (idempotent, run after the expand release) |
| B. Hostinger disk plus a public `/media/{hex}` route | $0 extra (included in the Business plan; the reviews disagree on the size, 50 or 200 GB) | About 1-2 days. A write path outside the deploy directory, a streaming route with `Cache-Control: immutable`, range requests for video, and a backup | Hostinger does not document a folder that survives a redeploy (the build is under `domains/{domain}/nodejs`), so ask Hostinger support first. Every Meta fetch and every video view goes through the Node app. Staging and live would need separate folders |
| C. Vercel Pro, keeping Blob as it is | $20 per seat per month (the credit included in it covers usage). Blob is about $0.023 per GB-month and about $0.05 per GB of transfer beyond what is included | About 0 code. Upgrade the team, and keep `BLOB_READ_WRITE_TOKEN` | Keeps a Vercel account and bill only for storage. No code risk, but the most expensive option per GB, and it keeps the dependency this change removes |

To check in hPanel first: is `BLOB_READ_WRITE_TOKEN` set on live? If it is not, live already runs with no media copy (fal images hot-linked, no kie or Higgsfield models offered), and the swap can wait until media is switched on.

Sources: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing), [Vercel Blob usage and pricing](https://vercel.com/docs/storage/vercel-blob/usage-and-pricing), [Hostinger Node.js deploy layout](https://www.hostinger.com/support/how-to-deploy-apps-built-with-codex-on-hostinger/).
