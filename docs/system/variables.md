# Nashr: environment variables (names only)

Every `process.env` reference in `src/`, `next.config.ts` and `scripts/` at HEAD `4959f7e`, with the rows for `APP_ORIGIN`, `RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAILS` and `WAITLIST_ADMIN_KEY` updated on 2026-09-29 for teams, which added no variable. No values are recorded here and no `.env*` file was opened to produce this list; names come from a source search for `process.env.` and from the `clientIdEnv` / `clientSecretEnv` fields in `src/lib/connectors/registry.ts`. Nothing uses the `NEXT_PUBLIC_` prefix, so no variable is compiled into client bundles; some are passed to client components as props by server components (noted below).

"Degrades gracefully" means the app keeps working with reduced function when the variable is unset. "Secret" means the value must not be disclosed.

## 1. Core platform

| Name | Enables | Read in | Without it | Secret |
|---|---|---|---|---|
| `KV_REST_API_URL` | Upstash Redis REST endpoint (first choice) | `src/lib/db.ts:22`, `src/app/api/waitlist/route.ts:8` | Falls back to `UPSTASH_REDIS_REST_URL`; if neither URL nor token is set, `db` becomes a process-local in-memory store (`db.ts:112`): data is lost on restart, not shared between function instances, and TTLs are ignored. The waitlist route only logs to the console and returns `stored:false`. Degrades silently, which is unsafe in production. | No (endpoint), treat as internal |
| `KV_REST_API_TOKEN` | Upstash Redis REST token (first choice) | `src/lib/db.ts:23`, `src/app/api/waitlist/route.ts:9` | Same as above | Yes |
| `UPSTASH_REDIS_REST_URL` | Alternate name for the Redis endpoint | `src/lib/db.ts:22`, `src/app/api/waitlist/route.ts:8` | Same as above | No (endpoint) |
| `UPSTASH_REDIS_REST_TOKEN` | Alternate name for the Redis token | `src/lib/db.ts:23`, `src/app/api/waitlist/route.ts:9` | Same as above | Yes |
| `ANTHROPIC_API_KEY` | All model calls. Read implicitly by `new Anthropic()`; checked explicitly to switch to mock behaviour | `src/lib/chat.ts:165`, `src/lib/noor.ts:139`, `src/lib/onboard.ts:73`, `src/lib/judge.ts:34`, `src/lib/images.ts:13`, `src/lib/golden.ts:182`, `src/app/api/tools/[tool]/route.ts:24`, `src/app/api/admin/golden/route.ts:15,23` | Graceful: chat replies with a `[DEV MOCK]` message, `generate` and onboarding return mock content, the judge returns no scores, image prompts use a fixed fallback, the golden set refuses to run (`no_model_key`), free tools echo inputs. Credits are still charged on `/api/generate`, MCP `generate_content` and the weekly run for mock items. Removing the key is therefore not the way to stop model calls in production: use `CLAUDE_PAUSED` in `src/lib/model.ts` (a constant in code, not a variable; on since 2026-09-28, flows.md §7 step 11), which only takes effect while a key is set. | Yes |
| `APP_ORIGIN` | Canonical public origin used for password-reset links, team invite links (`/{lang}/app/join#t=...`, 2026-09-29), notification and lifecycle email links, the daily cron's nudge and brief email links, connector OAuth `redirect_uri`, OAuth server issuer and endpoints, MCP `WWW-Authenticate` metadata URL, `robots.txt` and `sitemap.xml`, the MCP settings page | `src/lib/oauth.ts:9` (`ORIGIN()`, also used by `src/app/api/auth/forgot/route.ts` and `src/app/api/team/invite/route.ts`), `src/lib/notifications.ts:49`, `src/lib/lifecycle.ts:9`, `src/app/api/cron/daily/route.ts:18`, `src/lib/connectors/oauth.ts:4`, `src/app/api/mcp/route.ts:48`, `src/app/api/connect/[provider]/callback/route.ts:20`, `src/app/robots.ts:2`, `src/app/sitemap.ts:9`, `src/app/[lang]/app/mcp/page.tsx:14` | Falls back to a hard-coded production origin (or to the request host in the callback route and the MCP page). Works on the production domain; on any other domain, reset and invite links, OAuth redirect URIs and OAuth metadata point at production. The crawler user agent names the production origin regardless (`src/lib/crawl.ts`). | No |
| `NODE_ENV` | Sets the `secure` flag on cookies when equal to `production` | `src/lib/auth.ts:83`, `src/app/api/admin/login/route.ts:18`, `src/app/api/admin/impersonate/route.ts:11`, `src/app/api/admin/users/[email]/route.ts:87-88` | Cookies are issued without `secure` | No |

## 2. Access control

| Name | Enables | Read in | Without it | Secret |
|---|---|---|---|---|
| `ADMIN_EMAILS` | Comma-separated founder accounts: console access through the founder's own session (the owner login itself; since 2026-09-29 a member of a founder's account and a founder impersonating do not qualify, `isFounderActor`), founder sidebar link, recipients of golden-set regression notifications | `src/lib/auth.ts` (`adminEmails`, used by `isFounder` and `isFounderActor`) | Falls back to a single hard-coded address in the source. Not a failure mode: founder access still exists for that address. | No (but it identifies privileged accounts) |
| `WAITLIST_ADMIN_KEY` | Shared admin key: (1) accepted by `adminActor` / `isAdmin` in header `x-admin-key` (throttled) or cookie `nashr_admin`, and by `isAdminCookie` as the cookie, never in the URL; `admin:log` records it as the actor `"key"`, and an impersonation started with it carries `imp: "key"`; (2) checked by `POST /api/admin/login` before setting the cookie; (3) gates `GET /api/waitlist?key=`; (4) fallback encryption secret for connector credentials when `CONNECT_SECRET` is unset | `src/lib/auth.ts` (`adminActor`, `isAdminCookie`), `src/app/api/admin/login/route.ts:13`, `src/app/api/waitlist/route.ts:55`, `src/lib/connectors/store.ts:14` | Key-based admin access is disabled (login always 401, waitlist export always 401); founders still get in through `ADMIN_EMAILS`. Graceful. | Yes |
| `CRON_SECRET` | Bearer secret expected by the four cron routes, compared with `sameSecret` (Vercel Cron sends it automatically when configured) | `src/app/api/cron/daily/route.ts:68`, `src/app/api/cron/weekly/route.ts:15`, `src/app/api/cron/golden/route.ts:12`, `src/app/api/cron/routines/route.ts:18` | All cron routes return 401: no renewals, briefs, lifecycle emails, weekly plans, routines or golden runs. Fails closed. | Yes |
| `CONNECT_SECRET` | Source of the AES-256-GCM key (SHA-256 of the value) that encrypts connector tokens and API keys at rest | `src/lib/connectors/store.ts:14` | Falls back to `WAITLIST_ADMIN_KEY`, then to a fixed development string in the source. Connections still work, but the encryption key is then either shared with the admin key or publicly known. Changing the effective secret makes existing `conn:*` records undecryptable. Not a safe degradation. | Yes |

## 3. Email, images, support

| Name | Enables | Read in | Without it | Secret |
|---|---|---|---|---|
| `RESEND_API_KEY` | Sending email through Resend: password reset links, team invitations (2026-09-29), signup nudge, lifecycle emails, daily brief and follow-up emails, support-ticket forwarding | `src/lib/notify.ts:9,13` (`mailReady()` needs it and `MAIL_FROM`; `sendEmail`), `src/app/api/auth/forgot/route.ts` and `src/app/api/team/invite/route.ts` (through `mailReady()`), `src/lib/lifecycle.ts:66`, `src/app/api/cron/daily/route.ts:32` | Graceful: `sendEmail` returns `false` and no email is sent. The forgot endpoint answers `mail:false` so the UI points to WhatsApp support, and no reset token is created: self-service password reset is unavailable. The team invite route answers `emailed:false` and returns the join link once to the inviter to pass on. With both variables set, an invite whose email is refused (a Resend rate limit, a quota, a rejected recipient) is withdrawn and answered 502 `send_failed`: the link is never handed to the inviter then. | Yes |
| `MAIL_FROM` | Sender identity for all emails; also required by `mailReady()`, which decides whether the forgot route sends a reset link and whether the team invite route emails the invitation (2026-09-29) | `src/lib/notify.ts:9,15` | `sendEmail` falls back to a Resend sandbox sender (which may deliver only to the Resend account's own address), and `mailReady()` is false: no reset links, and invite links are returned to the inviter instead of emailed. | No |
| `WAITLIST_TO` | Address that receives a copy of each support or contact ticket | `src/app/api/support/route.ts:12` | Tickets are stored in Redis only. Graceful. | No (internal address) |
| `SUPPORT_WHATSAPP` | WhatsApp support number shown in the app sidebar, billing, help and forgot-password pages, and appended to nudge and lifecycle emails. Passed to client components as a prop. | `src/app/[lang]/app/layout.tsx:44`, `src/app/[lang]/app/billing/page.tsx:14`, `src/app/[lang]/app/help/page.tsx:9`, `src/app/[lang]/app/forgot/page.tsx:10`, `src/app/[lang]/help/page.tsx:15`, `src/app/api/cron/daily/route.ts:17`, `src/lib/lifecycle.ts:10` | Links are omitted. Billing falls back to a mailto link when no payment link is set either. Graceful. | No (published to users) |
| `FAL_KEY` | fal.ai FLUX image generation | `src/lib/images.ts:30` | Graceful: returns a placeholder image URL from a third-party placeholder service; 1 credit is still charged. | Yes |

## 4. Billing links

| Name | Enables | Read in | Without it | Secret |
|---|---|---|---|---|
| `PAY_LINK_STARTER` | External payment link on the billing page for the Starter plan | `src/app/[lang]/app/billing/page.tsx:13` | Button becomes a WhatsApp contact link (if `SUPPORT_WHATSAPP`) or a mailto link. Graceful. There is no payment webhook: plan changes are applied manually through `POST /api/admin/plan`. | No (shown to users) |
| `PAY_LINK_PRO` | Same for Pro | `src/app/[lang]/app/billing/page.tsx:13` | Same | No |
| `PAY_LINK_AGENCY` | Same for Agency | `src/app/[lang]/app/billing/page.tsx:13` | Same | No |

## 5. Connector OAuth application credentials

Read indirectly as `process.env[o.clientIdEnv]` and `process.env[o.clientSecretEnv]` in `src/lib/connectors/oauth.ts:16,25,33,34` and `src/lib/connectors/registry.ts:100`. The names are declared in `src/lib/connectors/registry.ts:83-91`. A provider is "available" only when both of its variables are set (`isAvailable`, `registry.ts:98-101`); otherwise `GET /api/connect/{provider}/start` returns 503 `provider_not_configured` and the integrations page shows it as unavailable. All degrade gracefully. Key-based connectors (WordPress, WooCommerce, Klaviyo, Odoo, PrestaShop, Telegram, Brevo) need no environment variable.

| Name | Provider | Secret |
|---|---|---|
| `X_CLIENT_ID` | X | No (public client id), keep internal |
| `X_CLIENT_SECRET` | X | Yes |
| `SHOPIFY_CLIENT_ID` | Shopify | No, keep internal |
| `SHOPIFY_CLIENT_SECRET` | Shopify | Yes |
| `GOOGLE_CLIENT_ID` | Google (Business Profile, GA4, Search Console, YouTube) | No, keep internal |
| `GOOGLE_CLIENT_SECRET` | Google | Yes |
| `META_APP_ID` | Meta (Facebook Page and Instagram publishing, and the separate Meta Ads results connection) | No, keep internal |
| `META_APP_SECRET` | Meta | Yes |
| `META_CONFIG_ID` | Meta, optional: the Facebook Login for Business configuration id. When set, the authorize URL sends `config_id` instead of `scope` | No, keep internal |
| `SALLA_CLIENT_ID` | Salla | No, keep internal |
| `SALLA_CLIENT_SECRET` | Salla | Yes |
| `ZID_CLIENT_ID` | Zid | No, keep internal |
| `ZID_CLIENT_SECRET` | Zid | Yes |
| `LINKEDIN_CLIENT_ID` | LinkedIn | No, keep internal |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn | Yes |
| `TIKTOK_CLIENT_KEY` | TikTok (sent as `client_key`) | No, keep internal |
| `TIKTOK_CLIENT_SECRET` | TikTok | Yes |
| `SNAP_CLIENT_ID` | Snapchat Ads | No, keep internal |
| `SNAP_CLIENT_SECRET` | Snapchat Ads | Yes |

## 6. Summary for auditors

- Total distinct names: 37 (19 in sections 1 to 4, 18 connector credentials).
- Secrets (17): `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_TOKEN`, `ANTHROPIC_API_KEY`, `WAITLIST_ADMIN_KEY`, `CRON_SECRET`, `CONNECT_SECRET`, `RESEND_API_KEY`, `FAL_KEY` (8 platform secrets), plus the 9 `*_SECRET` connector variables in section 5.
- Fail closed when unset: `CRON_SECRET`, key-based admin access (`WAITLIST_ADMIN_KEY`), OAuth connectors.
- Fail open or degrade unsafely when unset: Redis credentials (silent in-memory store), `CONNECT_SECRET` (weak or shared encryption key), `APP_ORIGIN` (links and OAuth endpoints pinned to the hard-coded production origin), `ADMIN_EMAILS` (hard-coded default founder address).
- Values stored outside the environment but derived from it: the `nashr_admin` cookie holds the `WAITLIST_ADMIN_KEY` value (`src/app/api/admin/login/route.ts:18`).
- No startup validation of required variables exists; each is read at call time.
- Teams (2026-09-29) added no variable. The invite route reads `APP_ORIGIN` (through `ORIGIN()`) for the join link and `RESEND_API_KEY` and `MAIL_FROM` (through `mailReady()` and `sendEmail`) to email it; without mail the link is shown once to the inviter.
