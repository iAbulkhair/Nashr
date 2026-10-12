# Coverage: client address behind Hostinger and Turnstile that fails closed (rules 908-909 and 978-979)

Status on 2026-10-11 on branch `claude/turnstile-client-ip` (no PR). From the 360 study finding C-005 (`docs/reports/2026-10-11-thakeen-360/04-C-security-compliance.md` on `claude/360-study-2026-10-11`). Numbers 908-909 and 978-979 were free on origin/main and in the open PR titles (#316 930-959, #319 987-990, #320 991-1010). Rule 773 (`tests/client-ip.test.ts`) is unchanged and still passes: off Vercel only `x-forwarded-for` counts, and only `src/lib/rate.ts` names an address header. The file carries 908, its lowest rule (rule 788's check), though the change was briefed as 0978. Flows section 51 item 7 now starts with the read-only check below.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 908 | `GET /api/admin/client-ip`: `isAdmin` first, else 401 `{ok:false}`; answers only about the caller's own request (`clientIpReport`: the `x-forwarded-for` list, `x-real-ip`, `x-vercel-forwarded-for`, `cf-connecting-ip`, `true-client-ip`, `onVercel`, `trustedProxyHops`, the bucket), `Cache-Control: no-store`, nothing stored or logged. The header names stay in `src/lib/rate.ts` | `tests/client-ip-turnstile.test.ts` (rule 908), `tests/client-ip.test.ts` (only `rate.ts` names the headers) | — |
| 909 | Both Turnstile keys unset in a production deploy stays open (the founder's switch) and logs `turnstile off` once per process, names only | `tests/client-ip-turnstile.test.ts` (rule 909) | — |
| 978 | Turnstile with exactly one of `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` set (`turnstileState()` = `half`) fails closed in a production deploy (`isProductionDeploy()`, staging included): `verifyTurnstile` is `unavailable` without calling Cloudflare, so signup and forgot answer 503 `captcha_unavailable`; the missing NAME is logged once per process, never a value. Outside production a half-configured deploy stays off (rule 426 unchanged). Both keys set verifies as before | `tests/client-ip-turnstile.test.ts` (rule 978: both halves in production, staging, development, both keys) | — |
| 979 | `TRUSTED_PROXY_HOPS`: off Vercel `clientIp` reads the `x-forwarded-for` entry that many from the right. Only a whole number 1 to `MAX_PROXY_HOPS` (3) counts, anything else is 1, the last hop (the behaviour before this rule, so nothing moves until the founder sets it). A list shorter than the count reads its first entry; an empty hop is still the shared `unknown`. Vercel's own headers still count only on Vercel | `tests/client-ip-turnstile.test.ts` (rule 979), `tests/client-ip.test.ts` (rule 773, unchanged) | — |

## Live evidence (2026-10-11, two `curl -sI` requests, read-only)

- `https://thakeen.com/` and `/api/health` answer with `server: hcdn`, `platform: hostinger`, `panel: hpanel`, `x-hcdn-request-id: ...-srv-edge8` / `-srv-edge9`, `x-hcdn-cache-status: DYNAMIC`, `x-hcdn-upstream-rt`. No `cf-ray`, no `via`. So Hostinger's own CDN (hcdn) is the front proxy, not Cloudflare; a header such as `cf-connecting-ip` is never set by the platform and would be the client's.
- Which entry of `x-forwarded-for` reaches `next start` is not visible from outside without spending a production limiter's tries. Rule 908 makes it visible to the founder.

## Not pinned

- The value of `TRUSTED_PROXY_HOPS` on live: unset (1) until the founder runs the check in flows section 51 item 7 with rule 908's route. If the last hop turns out to be the hcdn edge, today every caller behind one edge shares `signup:ip:` (5 an hour), `forgot`, the free tools (5 a day) and the admin-key throttle.
- Whether hcdn's origin can be reached directly, bypassing the CDN. If it can, a caller could write the entries a hop count above 1 reads; the fix then is at the host (origin allowlist), not in `clientIp`.
- Turnstile is still off on live (`turnstileKey: null`, 360 study C-005): both keys unset is the founder's choice, so this change only logs it.
- The `hostname` field of Cloudflare's siteverify answer is not compared with the site's host.
