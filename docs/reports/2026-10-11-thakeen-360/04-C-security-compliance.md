# Workstream C: security, privacy and compliance (2026-10-11)

Base: origin/main 3bf67673, live thakeen.com = production 487984f4 (health endpoint), draft #316 head 8a48bf58. Read-only: grep sweeps over `src/app/api` (117 route files) and `src/lib`, spot reads of high-risk files, `curl -I` on live, `gh issue list`. Builds on the 2026-10-10 leftovers audit (L008, L045, L055, L065, L066, L070, L074, L089, L099); items it already had are re-verified, not redone.

## Summary

1. The code-level controls hold. Every non-public route authenticates first. Every public route has a limit from `rate.ts`. No customer route builds a Redis key from a scope or email taken from the request. Crons and OAuth use `sameSecret`. Model HTML goes through `render()`, and every CSV export goes through `csvSafe`. No secret pattern was found in origin/main.
2. The biggest live exposure is outside the code. `nashr-tau.vercel.app` serves **main HEAD 3bf67673** (unreleased code, built 2026-10-10 16:45 UTC) with the old environment, which includes the `WAITLIST_ADMIN_KEY` printed in chat on 2026-09-17. That key opens the whole founder console on that deployment. VERIFIED: commit from `/api/health`.
3. Legal and PDPL are the launch blockers. The privacy policy:
   - names no legal entity
   - says nothing about cross-border transfer or the data region
   - lists Vercel but not Hostinger, Composio, Cloudflare, Paymob or Google
   - publishes a personal WhatsApp number as the rights contact

   No consent is recorded at owner signup. There is no breach plan. The site shows "+VAT" with no VAT registration, and the ZATCA invoice is a stub.
4. Live hardening gaps:
   - Turnstile is off (`turnstileKey: null` on live signup).
   - The CSP has no `default-src` or `script-src`.
   - `x-powered-by: Next.js` is exposed.
   - Behind hcdn, per-IP limits depend on an unverified `x-forwarded-for` order.
5. Draft #316 handles owner instructions well: they are fenced as data, gated by role and plan, and every gate stays in code. But its platform layer is trusted prompt text for every tenant, and the same single-factor admin key can write it. This raises the stakes of points 2 and the missing 2FA before merging.

## Current state

| Control | State | Evidence | Label |
|---|---|---|---|
| Auth first on API routes | 117 routes. All non-public ones call `currentUser` / `adminActor` / `sameSecret(CRON_SECRET)` / `userFromBearer`. | sweep of `src/app/api/**/route.ts` | VERIFIED |
| Rate limits on public routes | signup, forgot, login, waitlist, support, tools, oauth register/token, media hook, Paymob webhook, staging-access, impersonate stop, secretary token routes, team accept: all call `allow()`. Static `oauth/meta`, `oauth/resource` and `auth/logout` have none (acceptable). | `grep allow(` per route | VERIFIED |
| Tenant isolation | No key from request scope or email in customer routes. Team role and remove check `memberOf === owner.email`. One global key from free text: `integration-votes:{name}`. | `src/app/api/integrations/route.ts:22`, `src/lib/team.ts:362-404` | VERIFIED |
| `sameSecret` | All 8 cron routes; OAuth `client_secret` (#111 now fixed); admin key header (throttled 30/900 s). | `src/app/api/cron/*/route.ts`, `src/app/api/oauth/token/route.ts:21`, `src/lib/auth.ts:575-590` | VERIFIED |
| Secrets in URLs | None read from the query. ICS feed and booking tokens sit in the path by design (capability URLs, revocable). | grep `searchParams.get` | VERIFIED |
| `safeFetch` | Used for crawl, catalog, WordPress, WooCommerce, keyed connectors, booking, media. No default timeout. DNS checked, then resolved again. | `src/lib/safe-fetch.ts:7-11,65-82` | VERIFIED |
| Model HTML / CSV | All model and user `dangerouslySetInnerHTML` go through `render()`; 5 CSV routes use `csvSafe`. | `src/components/app/{ChatPanel,Inbox,OnboardCards}.tsx`, `src/app/api/*/export` | VERIFIED |
| Prompt-injection fencing | Brand file, memory files and crawl are fenced with `asData`; brand changes are proposals only; publish needs approval in code. | `src/lib/chat.ts:286-289`, `src/lib/onboard.ts:72` | VERIFIED |
| MCP OAuth | S256 required, exact redirect match at issue, codes hashed with a 10 min TTL, tokens hashed, 30-day access tokens. | `src/app/api/oauth/approve/route.ts:22,29`, `src/lib/oauth.ts:11,76-91` | VERIFIED |
| Connector OAuth | State is random, bound to a cookie, compared with `sameSecret` and matched to the provider; PKCE where supported; Shopify host regex and HMAC; tokens AES-256-GCM under `CONNECT_SECRET` with no key version. | `src/app/api/connect/[provider]/{start,callback}/route.ts`, `src/lib/connectors/store.ts` | VERIFIED |
| Session storage | `session:{token}` holds the raw token (OAuth and MCP are hashed). | `src/lib/auth.ts:310` | VERIFIED |
| Live headers (thakeen.com) | HSTS (no preload), nosniff, XFO DENY, referrer policy, permissions policy. CSP only covers frame-ancestors, base-uri, form-action and object-src, plus upgrade-insecure-requests. `x-powered-by: Next.js`. `/.well-known/security.txt` returns 404. | `curl -I` 2026-10-11 | VERIFIED |
| Turnstile live | `turnstileKey: null` in live signup HTML. | `curl https://thakeen.com/ar/app/signup` | VERIFIED |
| Account delete | Self-serve, password-confirmed, owner only; cascades every key family (`wipeAccount`). | `src/app/api/account/route.ts:72-80`, `src/lib/account.ts:59` | VERIFIED |
| Data export | No self-serve export; the privacy policy says "use the support form, within 30 days". | `src/lib/legal.ts:41` | VERIFIED |
| Signup consent record | Owners: none (only the "By continuing you agree" text). Partners: `consentAt` and `termsVersion` recorded. | `src/components/app/AuthForm.tsx:21`, `src/app/api/affiliates/route.ts:27` | VERIFIED |
| ZATCA | `invoiceForPayment` returns null; `PRICES_INCLUDE_VAT = false` ("+VAT" shown). | `src/lib/invoice.ts:23-26`, `src/lib/pricing.ts:133` | VERIFIED |
| CI security | No secret scanning and no dependency audit in `.github/workflows/ci.yml`. | `ls .github/workflows` | VERIFIED |
| Committed secrets | No sk-ant / AKIA / re_ / ghp_ / Upstash-like patterns on origin/main. `.env*` is ignored. | `git grep` | VERIFIED |

## Findings (P0 first)

**C-001 P0. The old Vercel deployment is live, runs unreleased main, and carries the leaked admin key.**
- `https://nashr-tau.vercel.app/api/health` reports commit 3bf67673, built 2026-10-10 16:45 UTC. Vercel still auto-deploys main.
- Its environment is the pre-Hostinger one. Per memory, the founder set new values only on hPanel on 2026-10-08 and left Vercel untouched. So `WAITLIST_ADMIN_KEY` there is presumably the one printed in chat on 2026-09-17.
- Sent as the `x-admin-key` header, that key passes `adminActor` (`src/lib/auth.ts:575-585`). That gives the whole console on that deployment: impersonating any account in the old Redis, top-ups, the users CSV export and plan changes. Its crons and old `ANTHROPIC_API_KEY` can also spend.
- Labels: the commit and live state are VERIFIED. The key value on Vercel is UNVERIFIED (I cannot read the Vercel environment).
- Fix (founder): stop the project (#319 dashboard steps) or at least rotate `WAITLIST_ADMIN_KEY`, `CRON_SECRET` and `ANTHROPIC_API_KEY` there today.
- Absorbs L008 and part of #319.

**C-002 P0. The privacy policy does not meet PDPL disclosure duties.**
- `src/lib/legal.ts` (36-42 and the Arabic version 11-17):
  - names no controller or legal entity and no address
  - has no cross-border transfer statement or data region (Upstash, Anthropic, Hostinger and fal/kie/Higgsfield are outside KSA)
  - lists Vercel and Vercel Blob but not Hostinger, Composio, Cloudflare Turnstile, Paymob or Google Workspace
  - has no breach-notification commitment (no breach plan exists in docs)
  - offers export only on request
- Generated media stays public after account deletion (`legal.ts:41`).
- Labels: VERIFIED against code. Legal sufficiency UNVERIFIED (needs the Saudi lawyer, issue #48).
- Absorbs L045, L099, L007, L017, #57 and #48.

**C-003 P0. VAT and ZATCA are not ready while the site prices "+VAT".**
- `PRICES_INCLUDE_VAT = false` (`src/lib/pricing.ts:133`), so the top-up card and plans show "+VAT".
- There is no VAT registration or commercial registration yet (issue #47 open).
- `invoiceForPayment` issues nothing (`src/lib/invoice.ts:23`).
- Collecting VAT without registration, or charging without a compliant invoice, is a legal exposure the moment the first payment lands. That includes manual top-ups through `/api/admin/topups`.
- VERIFIED in code. Registration status: VERIFIED open issue #47.
- Absorbs L004, L006 and L074.

**C-004 P1. The admin console is single-factor, and #316 widens what it controls.**
- `adminActor` accepts the key header, a key session, or an `ADMIN_EMAILS` login with a password only. There is no 2FA (L055).
- Production key rotation on 2026-10-08 is recorded only in memory: UNVERIFIED.
- Draft #316 adds a platform instruction layer rendered as "THAKEEN STANDARDS (follow them)" into every tenant's agent prompts. It is written by `POST /api/admin/skills` behind `adminActor` (branch `src/lib/agent-instructions.ts:133`, `src/app/api/admin/skills/route.ts:47`). One leaked key or password would then steer every customer's output.
- Fix: confirm the live key is not the leaked one, then add 2FA or a second factor for console writes before #316 merges.

**C-005 P1. Bot and abuse protection is weaker live than designed.**
- Turnstile is off on live (`turnstileKey: null`). Signup, forgot and free tools rely on per-IP limits alone.
- On Hostinger, `clientIp` takes the last `x-forwarded-for` entry (`src/lib/rate.ts:55-57`). Whether hcdn makes that the real client, a shared edge IP, or a value the client can spoof is UNVERIFIED (#102, L070).
- The free tools spend model money at 5 per IP per day (`src/app/api/tools/[tool]/route.ts:12,25`).
- Founder: set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`. Claude: add a header-echo probe on staging.

**C-006 P1. The CSP is minimal, and fingerprinting headers are exposed.**
- Live CSP has no `default-src` or `script-src` (#172 open).
- `x-powered-by: Next.js` is sent, because `poweredByHeader` is not disabled in `next.config.ts`.
- HSTS has no preload, and `security.txt` returns 404.
- VERIFIED by `curl -I` on thakeen.com and nashr-tau.

**C-007 P1. `safeFetch` and connector calls have no default timeout, and the DNS-rebinding gap remains.**
- `src/lib/safe-fetch.ts:7-11` documents the gap.
- Direct `fetch` calls without `AbortSignal` in `connectors/salla.ts:38,49,96`, `zid.ts:40,60,138`, `meta.ts:32,41`, `ads.ts:44,72`, `keyed.ts:53,114`. A slow provider holds a function until the platform timeout.
- VERIFIED. Absorbs L065 and #177.

**C-008 P1. Comparison pages state competitor prices with no date on the page.**
- `src/lib/pages-vs.ts:4-22` has $39, $20/mo and $49. The source comment says "as checked on the date in the pricing spec", but the page shows no date.
- No lawyer review yet (#131).
- VERIFIED in code. Legal risk UNVERIFIED (lawyer).

**C-009 P1. The terms are thin for a paid AI SaaS.**
- `src/lib/legal.ts:46-55` has:
  - no named company
  - no limitation of liability or warranty disclaimer
  - no suspension or termination clause
  - no fair-use clause (L060)
  - no acceptable-use list for AI misuse
  - no subscription refund rule beyond top-ups
  - no venue
- VERIFIED. The lawyer must review.

**C-010 P1. A personal WhatsApp number is the data-rights contact, and the WhatsApp password reset has no identity check.**
- The number appears in `src/lib/legal.ts:17,42` and `src/lib/help.ts`.
- #105: a manual WhatsApp reset with no identity check and a temporary password that never has to be changed.
- The number on the page is VERIFIED. The reset process is UNVERIFIED (it is an operating procedure, not code).

**C-011 P1. #316 instruction injection paths are designed safely, with residual risk.**
- Owner instructions are 600 characters each, screened (`instructions-safety.ts`), fenced with `asData`, and need `forbid(u,"instructions.write")`. Proposals from chat wait for the owner.
- Google Docs and Sheets reference files come through Composio as untrusted text in `<reference_files>`.
- Residual risk: owner instructions also reach the reviewer and the judge as data (`agent-instructions.ts` doc on `also`). An owner, or a member with write access, can steer the quality gate on their own account. The model is still not the only gate (publish and charge stay in code).
- VERIFIED on branch 8a48bf58. Not merged.

**C-012 P2. General prompt-injection residuals.**
- Planted text in files or crawl can make the chat model call `generate_content`. That spends the owner's credits within one turn, bounded by `CHAT_MAX_CALLS` and the balance (`src/lib/chat.ts:441,635-650`).
- The reviewer pass can be steered (#112).
- Regulated-industry rules are prompt-only (#103).
- VERIFIED in code.

**C-013 P2. Session tokens are stored raw.**
- `session:{token}` (`src/lib/auth.ts:310`). A Redis read leak means account takeover.
- OAuth, MCP and password-reset tokens are already hashed, so #114 is partly stale.

**C-014 P2. MCP OAuth leftovers.**
- One all-powerful scope (#106).
- 30-day access tokens (`src/lib/oauth.ts:11`).
- Re-authorising creates a second grant (#108).
- Registered clients never expire. Registration is now rate-limited, so #110 is partly done.
- The consent page is English-only (#127).
- #175 (non-S256 accepted) is STALE: S256 is now required (`approve/route.ts:29`).

**C-015 P2. Admin hygiene.**
- A second impersonation still overwrites `nashr_return` (`src/app/api/admin/users/[email]/route.ts:133-134`, #101).
- There is no key version on connector encryption (#92), so rotating `CONNECT_SECRET` breaks every connection.

**C-016 P2. The tenant guard test is narrow, and one global key comes from free text.**
- `tests/scope-usage.test.ts:13` walks `src/app` only (#120).
- `integration-votes:{name}` gives any account unlimited permanent keys and has no rate limit (#174).

**C-017 P2. There is no secret scanning or dependency audit in CI.**
- #178: a test session cookie is in history.
- #173: image-size via pptxgenjs.
- `npm audit` could not be run in this read-only pass.

**C-018 P2. Error logging may carry provider response text.**
- `src/lib/connectors/oauth.ts:45` puts up to 200 characters of the token endpoint's error body into the error, and `callback/route.ts:128` logs the raw error.
- 13 `console.error(..., e)` sites log whole error objects.
- Low risk (error bodies, not tokens), but this breaks the "never logged" intent.

**C-019 (done).** The baseline sweeps pass: auth first, rate limits, `sameSecret`, `render()` and `csvSafe` (see the table).

**C-020 P2.** Account deletion is self-serve, but generated media stays public after it. Fix once #320 storage lands.

## What could not be verified and why

- **Live `WAITLIST_ADMIN_KEY` and the Vercel environment:** I cannot read hPanel or Vercel values, and must not. Rotation on Hostinger rests on memory only (2026-10-08 "new values").
- **`clientIp` behind hcdn:** proving it means sending crafted `x-forwarded-for` requests to a production limiter, which writes production Redis. Left to a staging probe.
- **Whether nashr-tau's old `ANTHROPIC_API_KEY` is still valid, and whether real user data is in its old Redis:** testing would mean using credentials.
- **Legal sufficiency (PDPL, terms, comparative advertising, VAT):** needs the Saudi lawyer and accountant.
- **Dependency vulnerabilities:** `npm audit` was not run.
- **The WhatsApp manual reset procedure:** it is an operating practice, not code.
