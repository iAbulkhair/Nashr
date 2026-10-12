# Coverage: CI builds once, the build cache survives a red suite (rules 1207-1210)

Status on 2026-10-12 on branch `claude/ci-build-once` (draft PR). Rules 1200-1206 and 1220-1227 are taken by #331, main and #332, so this change uses 1207-1210; 1211-1219 stay free. Flows section 62, item 6. Follows rule 1017 (#324), which made CI build with `build:hostinger` on Node 22 and left the end-to-end server building a second time.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1207 | Under `CI` with `.next/BUILD_ID` present the end-to-end server runs only `npx next start -p PORT`; without `CI` or without a build it runs `npm run build:hostinger` first. `.next/cache` alone is not a build. The server keeps `APP_ENV=test` and `reuseExistingServer: false`; the workflow has one build line, the suite step builds nothing, and `timeout-minutes` is 35 since rule 1211 | `tests/ci-build-once.test.ts` (rule 1207 block: the command for all four cases, `hasBuild` in a temp dir, the config and workflow source) | — |
| 1208 | The Next build cache is restored (`actions/cache/restore@v4`, `id: next-cache`) before the Build step and saved (`actions/cache/save@v4`, key `cache-primary-key`) by the step straight after it, skipped on an exact hit; no combined `actions/cache` step holds `.next/cache`; restore-keys fall back to the lockfile, then to the OS | `tests/ci-build-once.test.ts` (rule 1208 block), `tests/ci-workflow.test.ts` (rule 772, step names updated) | — |
| 1209 | One build serves both checks: the Build step and the workflow set no `APP_ENV`; only `src/lib/deploy-env.ts` and `src/lib/verify-email.ts` read `process.env.APP_ENV`, at call time; `robots.ts` and `sitemap.ts` read only `isStaging()`, false both unset and under `test` | `tests/ci-build-once.test.ts` (rule 1209 block); a local comparison of two `next build --webpack` runs (unset and `APP_ENV=test`), see Notes | — |
| 1210 | Flows section 62, the architecture Build row and this file name the change | `tests/ci-build-once.test.ts` (rule 1210 block) | — |

## Notes

- Measured on PR #328 (runs 38187756048 and 38211318968, 2026-10-12): Build 15 s before rule 1017 (Turbopack, Node 24) and 1 m 46 s after it (webpack, Node 22, cold cache); the end-to-end step spent 60 s before "Running 1046 tests" (the second build plus `next start`), against 19 s before rule 1017; neither run saved the Next cache ("Post Cache Next build" was skipped because the job failed or was cancelled). The cancelled run hit 25 minutes 13 m 22 s into the suite.
- Expected after this change, per end-to-end run: about 50 s less before the first test (`next start` alone takes a few seconds), and every push after a PR's first run restores a warm build cache even when the earlier run was red, so later pushes build with a warm webpack cache instead of the cold 1 m 46 s (locally a warm webpack build took 19 s against 35 s cold, so CI's 1 m 46 s should drop to about a minute; read it off the second run). The first run of each PR still builds cold.
- Local proof of rule 1209 (2026-10-12, Node 24, outside the sandbox): `next build --webpack` with `APP_ENV` unset, then again with `APP_ENV=test`. Both prerendered the same 127 routes and 734 static files (`.html`, `.rsc`, `.body`, `.meta` under `.next/server/app`), and none of the 734 differed once each build's `BUILD_ID` was replaced by a placeholder; `app-path-routes-manifest.json` differed in key order only.
- Nothing stored changes shape. Release step: none (rule 679 not involved). No environment variable is added.
- The unit tests take about 7 minutes of each run (06:15:10 to 06:22:06 on the cancelled run); that is the largest step before the suite and is not part of this change.

## Not pinned

- That GitHub serves a cache saved mid-job to the next run of the same PR is GitHub's behaviour, read off the second CI run of a PR, not a unit test.
- That the prerendered pages of the two builds stay identical depends on future code: rule 1209 pins the readers of `APP_ENV`, not the HTML.
