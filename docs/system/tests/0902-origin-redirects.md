# Coverage: redirects and cron self-calls use the app origin (rule 902)

Status on 2026-10-10 on branch `claude/fix-proxy-origin-redirects`. Found by the 2026-10-10 leftovers audit with GET requests only: `GET https://thakeen.com/p/TEST` answered 307 to `https://0.0.0.0:3000/ar/app/signup`, so every partner link (rule 391) sent the visitor to a dead host. Behind the Hostinger proxy `req.url` is the internal address; on Vercel it was the public one, so the bug only showed after the move to Hostinger (2026-10-08). `GET /` and `GET /app` were not affected: the proxy redirects with `req.nextUrl`, which carries the public host.

Every place that built an absolute URL on `req.url` now builds it on `appOrigin()` (`src/lib/origin.ts`, `APP_ORIGIN`), as `connect/*` and `staging-access` already did:

- `src/app/p/[code]/route.ts`: the partner link's redirect to signup.
- `src/app/api/admin/impersonate/route.ts`: the return to `/{lang}/admin/users` when impersonation ends.
- `src/lib/cron-batch.ts`: the chain hop to a fresh invocation (same path and query, `chain` + 1).
- `src/app/api/cron/daily/route.ts`: the start of `/api/cron/weekly` on Sunday to Tuesday UTC.
- `src/app/api/cron/secretary/route.ts`: the evening kick `/api/cron/evening?zones=…`.

`new URL(req.url)` with no base argument (reading `searchParams`) is unchanged everywhere.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 902 | A redirect or a server-side call to the app itself is built on `appOrigin()`, never on the request URL; no file in `src/` passes `req.url` as the base of `new URL` | `tests/origin-redirects.test.ts` (4 tests, `req.url` = `https://0.0.0.0:3000`, `APP_ORIGIN` stubbed: the partner redirect, the impersonation return, the cron batch hop, and a source scan for `new URL(…, req.url)` plus the daily and secretary kicks); `tests/cron-batch.test.ts` now expects the hop on `appOrigin()` | — |

## Not pinned

- The live result. After the founder merges a release with this fix, `GET https://thakeen.com/p/TEST` should answer 307 to `https://thakeen.com/ar/app/signup`, and the next daily or secretary run should reach its chained route (Hostinger logs).
- Staging: the staging lock (rules 674-677) answers 404 to every path but its open ones without the access cookie, the cron routes included, so a cron hop on staging is refused whichever host it goes to. Unchanged by this rule.
- A Vercel preview without `APP_ORIGIN` would send a hop to the production fallback origin. Vercel runs crons on production only, so no preview makes such a hop.
