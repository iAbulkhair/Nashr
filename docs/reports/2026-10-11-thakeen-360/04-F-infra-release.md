# Workstream F: infrastructure, deploy and release (2026-10-11 ~02:15 UTC)

Read-only. Checks: `curl` GET/HEAD, `dig`, `gh` GET, `git` on origin/main and origin/production. Env var names only. Labels: VERIFIED / STALE / UNVERIFIED (reason).

## Summary

1. thakeen.com is healthy and on `487984f4` (#312, build stamped 2026-10-10 16:58 UTC), but still serves the `/p/<code>` 307 to `https://0.0.0.0:3000` bug. Fix #313 is on main only, and it also repairs cron chaining, evening-wrap hops and admin impersonation (F-001).
2. The release path is blocked by the founder-side staging setup: staging is deployed and its 404 is the lock working, not a missing deploy; but it has no Redis, so nobody can enter it and the documented smoke gate cannot run (F-002).
3. The old Vercel project is still a live, public, second copy of the product built from main HEAD, with its own backend, crons and, per memory, the admin key printed in chat on 2026-09-17 (F-003). #319 alone does not stop it.
4. Nothing watches production, backups are unverified, Turnstile is off, www has a bad certificate (F-004, F-005, F-006, F-008).
5. Pending release is 77 commits / 6 merged PRs, all expand-only or default-off, no env change: one release PR in the 22:00-00:40 UTC window is low risk once staging works (F-012).

## Current state

| Area | State | Evidence | Label |
|---|---|---|---|
| Live deploy | `production` = `487984f4`; `/api/health` commit `487984f4`, built 2026-10-10T16:58Z; `/` 307 `/ar`; `/ar` 200 | curl | VERIFIED |
| Build | `build:hostinger` = `next build --webpack`; CI runs Turbopack `next build` on Node 24; no `engines` / `.nvmrc` | package.json, ci.yml | VERIFIED |
| Node on host | 22.x (22.18 per memory); Composio wants >=22.22.3 | memory | UNVERIFIED: hPanel unreadable |
| Env on live | 11 names set 2026-10-08: ANTHROPIC_API_KEY, WAITLIST_ADMIN_KEY, CONNECT_SECRET, CRON_SECRET, ADMIN_EMAILS, MAIL_FROM, RESEND_API_KEY, APP_ORIGIN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, VERCEL_ENV | memory | UNVERIFIED: later changes unknown |
| Env not set (inferred) | TURNSTILE_*, FAL_KEY, KIE_*, HIGGSFIELD_*, BLOB_READ_WRITE_TOKEN, MEDIA_MODELS_ON, PAYMOB_*, COMPOSIO_*, GOOGLE_*, MICROSOFT_*, STRAITLY_*, QSTASH_*, WAITLIST_TO, SUPPORT_WHATSAPP, platform OAuth ids | variables.md vs list above; `turnstileKey:null` in signup HTML | VERIFIED for TURNSTILE; rest UNVERIFIED |
| Crons (9) | weekly, daily, golden, media, routines, evening, stores x2 (GET, UTC) + secretary `*/15` POST; routes exist; 7 GET routes 401 without bearer; secretary GET 405 | vercel.json, curl | VERIFIED routes, UNVERIFIED hPanel runs |
| Staging | Deployed from main on Hostinger; `/`, `/ar`, `/api/*`, `/m/*` 404 + `x-robots-tag: noindex, nofollow`; `/ar/staging-access` and `/robots.txt` 200; no usable Redis | curl, memory 10-10 20:15 | VERIFIED lock, UNVERIFIED Redis state today |
| Release flow | main to `production` by founder-merged release PR; ruleset 24747311: PR required, merge commit only, 0 approvals, no bypass, no required status check | gh | VERIFIED |
| Tags | `live-2026-10-08-1` (#297 79be2e1d), `live-2026-10-09-1` (#309 9bcaaf56), `live-2026-10-09-2` (#312 487984f4) | git | VERIFIED |
| Pending | `origin/main` 3bf67673 is 77 commits ahead: #298, #311, #313, #314, #315, #318 | git | VERIFIED |
| Old Vercel | serves `/ar` 200, `/ar/app/signup` 200, API 401s, health shows main HEAD `3bf67673`; own sitemap | curl | VERIFIED |
| #319 | draft, MERGEABLE, Nashr CI green, rules 987-990 | gh | VERIFIED |
| #320 | draft, MERGEABLE, spec only, hPanel checklist (spec section 9) open | gh, spec | VERIFIED |
| Backups | no evidence of Upstash backup | Owner_Tasks_AR.md:41 | UNVERIFIED |
| Monitoring | none in code or docs | grep | VERIFIED absence |
| Security headers | HSTS 2y, nosniff, Referrer-Policy, XFO DENY, minimal CSP, Permissions-Policy; `x-powered-by` exposed | curl, next.config.ts | VERIFIED |
| DNS / TLS | apex OK (HTTP 301 to https); `www` CNAME to hstgr CDN with certificate mismatch; DMARC `p=none` | curl, dig | VERIFIED |
| CI | PR runs ~6-21 min; push-to-main ~7 min until #319; 200 runs since 10-08 | gh | VERIFIED |

## Pending release (origin/production..origin/main)

| PR | What | Stored shape | Env | Live effect |
|---|---|---|---|---|
| #298 | Model catalog, tiered credits, routing, Straitly (+7938/-243, 85 files) | expand-only optional fields (`conversation.model`, `brand.model`, `user.chinaHostingOk`) | none (`LLM_PROVIDER` defaults `anthropic`) | none visible; default off |
| #311 | Home wording and sliding scenes | none | none | visible homepage change |
| #315 | #298 follow-ups (wipeAccount race, brand lock 503, Premium hold) | none | none | small fixes |
| #313 | Origin fix (rule 904) | none | none | fixes `/p/`, cron chaining, evening hop, impersonate redirect |
| #314 | Reem B2b/B3 + PRD v3.2 (+8136) | expand: optional `SecCalendar.workHours` | GOOGLE_*/MICROSOFT_* still unset, so calendars stay unlinkable | dormant |
| #318 | Meter every billed model call; 5.5 models only | none | none | usage counters grow; pre-5.5 picks run on default |

Source: PR bodies (not full diff review). Release PR must state: "expand only".

## Findings (P0 first)

Full detail in `raw/findings-F.jsonl` (F-001 to F-025).

**P0**
- F-001 `/p/` bug and sibling cron/impersonate hops live until #313 ships. VERIFIED (live curl; cron effect inferred from `req.url` use on production).
- F-002 Staging unusable (no Redis, no access): release gate cannot be met. Founder sets staging env names (Upstash pair, CRON_SECRET, CONNECT_SECRET, APP_ORIGIN, APP_ENV, STAGING_ACCESS_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, MAIL_FROM). VERIFIED lock; Redis state from memory.
- F-003 Old Vercel project still public and running main HEAD with own backend and crons; admin key exposure per memory. Founder dashboard steps; #319 does not stop it.

**P1**
- F-004 No monitoring or cron-failure alerting. F-005 Upstash backup unverified. F-006 Turnstile unset (signup/forgot unprotected). F-007 rate-limit client address behind hcdn unproven. F-008 www TLS mismatch. F-009 cron header file survival unproven. F-010 #319 founder steps. F-011 CI builds Turbopack/Node 24, live builds webpack/Node 22, no Node pin. F-012 pending release plan. F-014 media storage #320 prerequisites. F-015 shared-hosting capacity unknown.

**P2**
- F-013 production ruleset has no required check, no rollback rehearsal. F-016 env gap (dormant features). F-017 `/api/health` does not check Redis. F-018 unexplained daytime rebuild at 16:58 UTC. F-019 CSP minimal, `x-powered-by`. F-020 DMARC `p=none`. F-021 CI minutes. F-022 docs drift (flows 52 status line, architecture.md "Vercel"). F-023 hcdn cache purge unproven. F-024 cron inventory consistent (done). F-025 leftover QStash schedule.

## Vercel retirement (#319) and media (#320) in one view

- #319: code part is ready; the actual retirement is three founder steps (Vercel disconnect or delete plus remove Deployment Check; hPanel add `APP_ENV=production`, redeploy, check `/api/health`, delete `VERCEL_ENV`; check `BLOB_READ_WRITE_TOKEN`). Its body still recommends Cloudflare R2; the founder later chose Hostinger disk in #320. Privacy policy and help text still name Vercel Blob.
- #320: spec decisions D1-D8 recorded; nothing built; Blob remains the code path and `@vercel/blob` a dependency until an expand-then-contract release. Rule range inconsistent (title 991-1010, body 991-1015).

## What could not be verified and why

- hPanel (env values and names today, Node patch version, cron list and last run output, resources usage, backup scope): Hostinger panel not readable from here, and an earlier read was refused by the permission layer. Memory dated 2026-10-08 is the only source.
- Upstash console (backup setting, plan, QStash schedules) and Vercel dashboard (what the old project holds, its env, its cron state): not readable.
- That the staging access POST still returns 500: POST not allowed in this study; inferred from memory 2026-10-10 20:15.
- Client-IP behaviour behind hcdn (F-007): requires spoofed-header probing, forbidden without the founder's OK.
- hcdn cache purge on deploy (F-023): one sample only.
- Full diff of the 77 commits: PR bodies and release-step sections only; no code review of the batch.
- Billed CI minutes: wall-clock from `gh run list` is an approximation; plan pricing is not in the repo.
