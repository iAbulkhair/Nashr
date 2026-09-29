# Nashr: system architecture (as implemented)

Baseline written from the code on branch `claude/cool-tu-144390` (HEAD `4959f7e`), 2026-09-18. It describes what the code does, not what it should do. Paths are relative to the repository root. `file:line` references point at the first relevant line.

## 1. Summary

Nashr is a single Next.js 16 app-router application (TypeScript, React server components, no separate backend) deployed on Vercel. It serves a bilingual (Arabic default, English) marketing site and an authenticated app under `/{lang}/app` in which a small-business owner talks to seven AI agents (Noor marketing, Sami sales, Razan finance, Faris growth, Dana reporting, Majed executive, Layan product; `src/lib/agents.ts:21`). Agents call Anthropic models through `@anthropic-ai/sdk`, produce content "tasks" that land in an approval inbox, and can publish approved items to third-party platforms through connectors. All state lives in one Upstash Redis database reached through a thin adapter (`src/lib/db.ts`); when no Redis credentials are present the adapter silently falls back to a process-local in-memory `Map` (`src/lib/db.ts:112`). There is no SQL database, no queue and no background worker: long work runs inside the request (route `maxDuration` up to 300 s), after the response via Next `after()` (`src/lib/judge.ts:90`), or in three Vercel cron jobs. Usage is metered in credits held on the user record. The same agent capabilities are exposed to external AI clients through an MCP endpoint (`/api/mcp`) protected by personal bearer tokens or by a built-in minimal OAuth 2.1 authorization server.

## 2. Component map

### 2.1 Edge / routing

| Component | File | Role |
|---|---|---|
| Proxy (Next 16 replacement for middleware) | `src/proxy.ts:15` | Matcher `["/", "/:lang/app/:path*"]` (`:32`). `/` is redirected (307) to `/ar` or `/en` from the `nashr_lang` cookie, then `Accept-Language`, default Arabic (`:5-13`). For app paths it only copies the pathname into the request header `x-pathname` (`:27-29`). It performs no authentication. |
| Rewrites | `next.config.ts:4-11` | `/.well-known/oauth-authorization-server[/*]` to `/api/oauth/meta`; `/.well-known/oauth-protected-resource[/*]` to `/api/oauth/resource`. |
| Robots | `src/app/robots.ts:4` | Disallows `/api/`, `/ar/app/`, `/en/app/`. |
| Cron schedule | `vercel.json` | See 2.6. |

### 2.2 Marketing site (public, `src/app/[lang]/*`)

Root layout `src/app/[lang]/layout.tsx` (static params for `ar`, `en`). Pages: home `page.tsx`, `agents`, `agents/[agent]`, `ai-marketing-agent`, `affiliates`, `blog`, `blog/[slug]`, `customers`, `enterprise`, `for/[industry]`, `help`, `pricing`, `privacy`, `terms`, `resources`, `tools`, `updates`, `vs`. Content comes from static modules (`src/lib/i18n.ts`, `site.ts`, `changelog.ts`, `pages-vs.ts`, `pages-industry.ts`, `legal.ts`, `help.ts`, `blog.ts` reading `content/`). Public forms post to `/api/support` (`src/components/ContactForm.tsx:15`, `HelpCenter.tsx:17`), `/api/affiliates` (`AffiliateForm.tsx:12`) and `/api/tools/{tool}` (`ToolForm.tsx:16`). No component posts to `/api/waitlist` any more (only the route itself references it).

### 2.3 App shell (`src/app/[lang]/app/*`)

`layout.tsx` resolves the session (`currentUser()`), redirects anonymous visitors to login unless the path ends with one of `/login /signup /forgot /reset /admin` (`layout.tsx:14-24`), renders the sidebar, trial banner, and an impersonation banner when the `nashr_impersonate` cookie exists (`:41-52`). Pages: inbox (`page.tsx`), `chat`, `conversations`, `generate`, `calendar`, `files`, `tasks` (schedule), `governance`, `integrations`, `mcp`, `billing`, `refer`, `reports`, `notifications`, `profile`, `brands`, `inspo`, `help`, `start`, `onboarding`, `login`, `signup`, `forgot`, `reset`, `admin`. The OAuth consent screen lives outside the language tree at `src/app/oauth/authorize/page.tsx`.

### 2.4 API routes (63 route files, 90 method handlers plus 5 CORS `OPTIONS`)

| Area | Routes |
|---|---|
| Auth | `auth/signup`, `auth/login`, `auth/logout`, `auth/forgot`, `auth/reset`, `account` |
| Workspace | `brand`, `brands`, `profile`, `files`, `governance`, `schedule`, `brief`, `notifications`, `conversations` |
| Agents / content | `chat`, `chat/feedback`, `generate`, `onboard`, `onboard/confirm`, `onboard/plan`, `catalog`, `tasks`, `tasks/[id]`, `tasks/[id]/image`, `tasks/[id]/pptx`, `tools/[tool]` |
| Connectors | `connect`, `connect/[provider]`, `connect/[provider]/start`, `connect/[provider]/callback`, `connect/[provider]/key`, `publish/[id]`, `integrations` |
| MCP and OAuth server | `mcp`, `mcp/token`, `oauth/register`, `oauth/approve`, `oauth/token`, `oauth/meta`, `oauth/resource` |
| Growth / inbound | `referral`, `referral/share`, `support`, `affiliates`, `waitlist`, `wishlist/vote`, `wishlist/suggest` |
| Founder console | `admin/login`, `admin/overview`, `admin/plan`, `admin/users/[email]`, `admin/impersonate`, `admin/export`, `admin/log`, `admin/evals`, `admin/golden`, `admin/wishlist` |
| Cron | `cron/daily`, `cron/weekly`, `cron/golden`, `cron/routines` |

Per-route authorization is in `permissions.md`.

### 2.5 Library modules (`src/lib`)

| Module | One line |
|---|---|
| `db.ts` | Storage adapter: Upstash REST client or in-memory fallback; `get/set(ttl)/del/lpush/lrange/sadd/smembers/scardMany (every set size in one pipelined request)/incrby/lock/unlock`. Memory fallback ignores TTL on `set` (`:70`). |
| `auth.ts` | `User` type, bcrypt password hashing, session cookie `nashr_session`, `currentUser()`, scope helper `sc(u)`, founder/admin checks. |
| `brands.ts` | Multi-brand workspaces: brand list, active brand, `scopeFor(email, brandId)`, per-plan brand limit. |
| `brand.ts` | `Brand` file, `Task` records, task costs and counts, owner preference notes (`listPreferencesFor` gives one agent's prompts the notes that are not about another agent's work). |
| `credits.ts` | Credit ledger under a per-user Redis lock: `charge`, `adjust`, `refund`, monthly `renewIfDue`. Since 2026-09-29 a charge carries `{scope, agent, cap}`: it counts the credits against the agent that owns the work in that brand scope (`User.agentSpend`, same save as the balance), refuses with `agent_cap` over the owner's monthly cap before the balance is touched, and `refund` given the charge's result lowers the same counter in the same month only. `agentSpendFor(u, scope)` reads this month's counters. |
| `chat.ts` | Agent chat loop (Anthropic streaming, up to 5 tool turns), tool definitions and `runTool`, chat history lists. |
| `noor.ts` | Batch content generation (`generate`), task specs, second-pass reviewer `critique` (one prompt per owning agent, `reviewerPrompt`). |
| `judge.ts` | Post-response quality scoring of generated tasks (`judgeLater` via `after()`), scored against the owner's notes and workspace data, with automatic-fail caps (`AUTOFAIL`). |
| `evals.ts` | Behavioural metrics per agent, chat thumbs storage. |
| `decisions.ts` | The owner's decision records per scope (`decisionOf`, `recordDecisions`, `listDecisions`), written by the approve and publish routes. |
| `feedback.ts` | `feedbackFor(scope, agent)`: the last 30 days of the owner's decisions, typed reasons, the judge's low scores and (chat only) thumbs-down reasons on one agent's own work, as escaped data for that agent's next prompt (uncached block, `feedbackBlock`); empty when `gov.learning` is off. |
| `golden.ts` | Weekly fixed "golden set" regression run across agents. |
| `onboard.ts` | Builds brand file, workspace files and starter plan from a crawled site in three parallel model calls (`PARTS`: core, identity, market), one retry per part. |
| `onboard-confirm.ts` | The owner's confirmation of the site onboarding builds from (`onboardok:{scope}`); a link only pre-fills the start page. |
| `crawl.ts` | Fetches a user-supplied URL server-side and reduces HTML to text, colors, fonts, platform. |
| `catalog.ts` | Discovers product URLs via sitemaps/robots and scrapes product pages into `products.md`. |
| `files.ts` | Workspace Markdown files ("memory"), `memoryBlock` for prompts (opens with the owner's onboarding goal). |
| `conversations.ts` | Multiple chat threads per scope, substring search. |
| `governance.ts` | Per-scope rules: auto-approve by type, weekly cap, learning, reviewer, dash stripping, and a monthly credit cap per agent (`agentCaps`). `saveGov` validates every field of the request body (agent ids, task types, booleans, finite numbers, clamps). |
| `brand-rules.ts` | Import-free brand gate: banned words as rules (`brandRules`, `checkText`, `gateTask`, `initialStatus`), used by the approve and publish routes, auto-approval, the chat publish tool, the MCP `check_brand` tool, the golden evals and the inbox. |
| `ad-codes.ts` | Import-free ad codes: `newAdCode`, `codesIn`, `withoutCodes`, and which item types carry one. |
| `connectors/ads.ts` | Read-only Meta Ads and Snapchat Ads readers: ad accounts, last-30-day results per ad as import rows, account choice. |
| `perf-import.ts` / `perf-store.ts` | Campaign CSV import: import-free parser, metric choice and findings (browser-safe), and the store that keeps the snapshot and writes `performance-learnings.md`. |
| `journey.ts` / `journey-load.ts` | Launch journey: milestones, levels and streak computed from workspace state (pure, browser-safe) and its one-round server loader. |
| `schedule.ts` | Per-scope schedule flags and routine switches (`Schedule.routines`, merged per id), weekly plan run, daily brief, `allUsers()` fan-out. |
| `routines.ts` | Owner-enabled routines for agents with real input data (`ROUTINES`: Dana's weekly report, Noor's cart recovery, Razan's cash forecast, Majed's monthly review), each with a gate checked in code; `runRoutine` (period, model state, lock, trial, gate, weekly cap, charge with the agent's cap, refunding generation, save, judge, notify) and `dueRoutines` for the cron. |
| `changelog.ts` | Import-free content for `/{lang}/updates`: `CHANGELOG` (dated, tagged, bilingual entries of merged work), `SEED_WISHES` (wishlist items with stable ids), statuses and the page copy. Safe to import from client components. |
| `wishlist.ts` | Wishlist storage: `listWishes` (counts in one `scardMany`), `setVote`, `votableId` / `existingId`, suggestions queue, founder promote / status / hide / delete, `cleanText`, and `forgetWishlistUser` for account deletion. Server only. |
| `notifications.ts` | In-app notifications per account, daily follow-ups with dedupe fingerprints. |
| `lifecycle.ts` | Lifecycle emails (day 1, 2, 3, 10), once per user. |
| `notify.ts` | `sendEmail` via Resend, `once()` guard. |
| `images.ts` | Image prompt (Anthropic) plus fal.ai FLUX call; placeholder image when `FAL_KEY` is absent. |
| `usage.ts` | Model token and cost metering per account per month, per kind and (since 2026-09-29) per agent. `usageMonthKeys` lists every counter of one month and is what `wipeAccount` deletes. |
| `track.ts` | Product analytics counters and active-user sets in Redis. |
| `stats.ts` | Workspace KPIs from stored tasks; `statsFor` gives Dana's tasks and Majed's strategy review the WORKSPACE DATA plus STORE DATA (`salesDataBlock` in `store-sales.ts`) when a store was synced, Razan's cash forecast the STORE DATA alone, and cart recovery the CART DATA. |
| `admin-stats.ts` | Founder overview and users CSV. |
| `referral.ts` | Deterministic referral codes, two-sided credit grant. |
| `mcp.ts` | Personal MCP tokens and `userFromBearer`. |
| `oauth.ts` | Minimal OAuth 2.1 server: metadata, dynamic client registration, codes, tokens, refresh rotation. |
| `rate.ts` | Fixed-window rate limiter `allow()` and `clientIp()` (first `x-forwarded-for` hop). |
| `account.ts` | `wipeAccount` account deletion. |
| `connectors/registry.ts` | Provider catalog: 7 key-based, 9 OAuth; env names for client credentials. |
| `connectors/store.ts` | AES-256-GCM encrypted connection records, OAuth state records. |
| `connectors/oauth.ts` | Authorize URL builder, PKCE pair, code exchange. |
| `connectors/publish.ts` | `targetsFor` and `publishTask` dispatch (WordPress, Shopify, Telegram, X). |
| `connectors/{wordpress,shopify,woocommerce,keyed,x,salla,zid,meta}.ts` | Provider API calls: verify, import products, publish, and (Salla, Shopify, Zid) the store-sales sync; `sales.ts` holds the shared snapshot shape. |
| `agents.ts`, `skills.ts`, `playbooks.ts`, `seasons.ts`, `tools.ts`, `integrations.ts`, `inspo.ts`, `help.ts`, `legal.ts`, `site.ts`, `pages-*.ts`, `blog.ts`, `md.ts`, `json.ts`, `parallel.ts`, `i18n.ts`, `app-i18n.ts` | Static catalogs, prompt material, copy, and small utilities (Markdown renderer, tolerant JSON parser, bounded `pmap`). |

### 2.6 Cron jobs (`vercel.json`)

| Path | Schedule (UTC) | What it does |
|---|---|---|
| `/api/cron/weekly` | `0 3 * * 0` | For every (user, active brand): `runWeekly` generates a weekly plan, charging 1 credit (`src/lib/schedule.ts:32`). |
| `/api/cron/daily` | `0 5 * * *` | Monthly credit renewal, signup nudge email, lifecycle emails, daily brief, follow-up notifications, brief email (`src/app/api/cron/daily/route.ts:13`). |
| `/api/cron/golden` | `0 1 * * 6` | Runs the golden regression set (`src/lib/golden.ts:181`). |
| `/api/cron/routines` | `0 6 * * *` | For every (user, active brand) routine that is on and has not run in its week or month (`dueRoutines`): `runRoutine`, one generation per item, charging the owning agent (`src/lib/routines.ts`). After the 05:00 daily job, so credits are renewed first. |

All four require `Authorization: Bearer ${CRON_SECRET}` (compared with `sameSecret`) and return 401 when the variable is unset.

### 2.7 External services

| Service | Used for | Call sites |
|---|---|---|
| Anthropic API | Chat (`claude-opus-5`, `src/lib/chat.ts:185`), generation (`claude-opus-5`, `noor.ts:146`), reviewer (`claude-sonnet-5`, `noor.ts:186`), judge (`judge.ts:38`), onboarding (`onboard.ts:106`), image prompt (`images.ts:16`), free tools (`api/tools/[tool]/route.ts:28`). Key read implicitly by the SDK from `ANTHROPIC_API_KEY`. **Paused since 2026-09-28:** every call site checks `modelState()` in `src/lib/model.ts`, and `CLAUDE_PAUSED = true` there stops all of them on a deployment that has a key (flows.md §7 step 11). |
| Upstash Redis (REST) | All persistence (`src/lib/db.ts:21`), plus a second direct client in `api/waitlist/route.ts:7`. |
| fal.ai | Image generation `https://fal.run/fal-ai/flux/schnell` (`src/lib/images.ts:34`). |
| placehold.co | Placeholder image URL when `FAL_KEY` is absent (`images.ts:32`). URL only, no server fetch. |
| Resend | Transactional and lifecycle email (`src/lib/notify.ts:4`). |
| Vercel | Hosting, function runtime, cron. |
| Connector platforms | X, Shopify, Google, Meta, Salla, Zid, LinkedIn, TikTok, Snapchat (OAuth); WordPress, WooCommerce, Klaviyo, Odoo, PrestaShop, Telegram, Brevo (keys). Actual API use exists for X, Shopify, Meta (Facebook Page and Instagram publishing), WordPress, WooCommerce, Odoo, PrestaShop, Telegram, Salla and Zid (product import and the store-sales sync), Brevo (verify only), Klaviyo (verify only). Google, LinkedIn, TikTok, Snapchat only complete the OAuth exchange and store tokens. |
| Arbitrary customer websites | `crawl.ts:50` and `catalog.ts:12,26` fetch URLs supplied by the user or discovered in sitemaps. |

## 3. Redis key namespace

"scope" means `email` for the default brand or `email#brandId` for extra brands (`src/lib/brands.ts:27`). "email" means the normalized account email. No key has a TTL unless stated.

| Key pattern | Type | Stores | Owner module | TTL |
|---|---|---|---|---|
| `user:{email}` | json | `User` without `scope`/`brandId` (includes `passHash`, plan, credits, `suspended`, and `agentSpend: {month, by: {scope: {agent: credits}}}`, the current UTC month's credits per brand scope and agent, written only by `charge` and `refund`) | `auth.ts:47,53`, `credits.ts` | none |
| `users:all` | set | All account emails | `auth.ts:54`; read by `schedule.ts:106`, `admin-stats.ts:24`, `api/admin/plan`, `api/admin/export` | none |
| `session:{token}` | json | `{email, at}` for a 32-byte hex session token (records from before 2026-09-18 are a bare email); dead when `at` is older than the user's `sessionsAfter` | `auth.ts:81,97` | 30 days |
| `pwreset:{sha256(token)}` | json | `{email}` for a password reset | `api/auth/forgot/route.ts:27`, `api/auth/reset/route.ts:16` | 1 hour |
| `rate:{bucket}` | int | Fixed-window counter. Buckets: `forgot:ip:{ip}`, `forgot:em:{email}`, `reset:ip:{ip}`, `adminkey:{ip}` | `rate.ts:5` | window seconds |
| `lock:user:{email}` | lock | Per-user credit/ledger mutex | `credits.ts:12` | 10 s |
| `brands:{email}` | json | `BrandMeta[]` | `brands.ts:14` | none |
| `activebrand:{email}` | string | Active brand id | `brands.ts:22` | none |
| `brand:{scope}` | json | `Brand` file | `brand.ts:83` | none |
| `tasks:{scope}` | list | Task ids, newest first (reads cap at 200) | `brand.ts:89,96` | none |
| `task:{scope}:{id}` | json | `Task`. Since 2026-09-29 every creation path sets `source` (`manual` on `/api/generate`, `chat` for chat and MCP, `scheduled` for the weekly plan and the routines) and `brief`: the batch's notes or brief, first 500 characters, when there were any (`briefOf`); a routine's batch carries the routine id | `brand.ts:95` | none |
| `pending:{scope}`, `pendingidx:{scope}` | set / string | Ids waiting for approval, maintained by `saveTask`; marker of the first indexing | `brand.ts` | none |
| `tidx:{scope}:{YYYY-MM}` | hash | Light task rows (`TaskLite`, no body; the judge's score, notes and, since 2026-09-29, automatic-fail code) by creation month, written by `saveTask`; read by KPIs, calendar, briefs, follow-ups, metrics | `brand.ts` (`listLite`) | none |
| `tidxm:{scope}`, `tidxv:{scope}` | set / string | Months that have an index hash; when the index was last rebuilt from the tasks (first use, then weekly in `runDaily`) | `brand.ts` | none |
| `prefs:{scope}` | list | Learned preference notes (reads cap at 30, list trimmed to 100). Prompts for a known agent read `listPreferencesFor`: the whole list, less the notes naming a task type another agent owns, newest 30 | `brand.ts` | none |
| `decisions:{scope}` | list | The owner's decisions on agents' work, one JSON `Decision` per human decision (`approve`, `reject`, `edit`, `reopen` from `PATCH /api/tasks/{id}`; `publish` when publishing approves a pending item): task id, owning agent (`agentForTask`, computed in code), type, channel, title (80), the owner's typed reason (300), edit size (`editPctOf`), judge score and automatic-fail code at that moment. Append-only, newest first, trimmed to 500; written whether or not `gov.learning` is on; auto-approved items are never recorded. Read by `feedbackFor` for the owning agent's prompts (last 30 days, only while `gov.learning` is on). Deleted by `wipeAccount` | `decisions.ts`, `feedback.ts` | none |
| `files:{scope}` | set | Workspace file names | `files.ts:6` | none |
| `file:{scope}:{name}` | json | `WFile`; delete writes `null` tombstone, the set member stays (`files.ts:32-37`) | `files.ts:7` | none |
| `chat:{scope}` | list | Default thread messages (JSON `ChatMsg`) | `chat.ts:27` | none |
| `chat:{scope}:{conv}` | list | Messages of conversation `conv` | `chat.ts:27` | none |
| `convs:{scope}` | list | Conversation ids | `conversations.ts:10` | none |
| `conv:{scope}:{id}` | json | `Conversation` metadata | `conversations.ts:17` | none |
| `gov:{scope}` | json | `Governance` | `governance.ts:16` | none |
| `schedule:{scope}` | json | `Schedule`, including the owner's routine switches (`routines: {id: boolean}`, all off by default) | `schedule.ts` | none |
| `routinelast:{scope}:{routineId}` | string | ISO time of the routine's last successful run in this brand, one key per routine so two routines never race on one read-modify-write; decides the week or month period and Noor's "synced since the last run" gate | `routines.ts` | none |
| `routinelock:{scope}:{routineId}` | lock | One run of a routine per brand at a time | `routines.ts` | 300 s |
| `routinecap:{scope}` | lock | The weekly-cap check and hold of one routine at a time per brand (a few reads; waited for up to about 2 s) | `routines.ts` | 10 s |
| `routinehold:{scope}:{routineId}` | number | `TASK_COUNT` of a batch that passed the weekly-cap check and is not saved yet; the brand's other routines count it, and the run deletes it after saving | `routines.ts` | 360 s |
| `routinetry:{scope}:{routineId}:{period}` | number | Charges of the routine in this week (`YYYY-MM-DD` of the Sunday) or month (`YYYY-MM`) that were neither refunded nor refused, i.e. left by a killed run; at more than 2 the routine waits for its next period | `routines.ts` | 8 or 35 d |
| `brief:{scope}` | json | Latest daily brief | `schedule.ts:28,98` | none |
| `onboardplan:{scope}` | json | Starter plan and one-line output goal from onboarding; the goal opens every agent's `memoryBlock` | `api/onboard/route.ts:67`, `api/onboard/plan/route.ts`, `files.ts` `memoryBlock` | none |
| `onboardlock:{scope}` | lock | One onboarding run at a time | `api/onboard/route.ts:44` | 240 s |
| `onboardok:{scope}` | string | The site URL the owner confirmed on the start page; the only one `POST /api/onboard` builds from | `lib/onboard-confirm.ts`, `api/onboard/confirm/route.ts`, `api/onboard/route.ts` | 1 day; deleted by a finished build |
| `conns:{scope}` | set | Connected provider ids (never shrinks) | `connectors/store.ts:35` | none |
| `conn:{scope}:{provider}` | json | Connection with AES-256-GCM `enc` blob; delete writes `null` | `connectors/store.ts:34,52` | none |
| `oauthstate:{state}` | json | Connector OAuth state `{email: scope, provider, lang, shop, verifier}` | `connectors/store.ts:56` | 10 min |
| `adcodes:{scope}` | hash | Ad code → task id, one entry per new ads or social item, used to find Nashr's ads in results | `brand.ts` | none |
| `adsync:{scope}:{provider}` | string | When the ad account of `meta_ads` or `snapchat` was last read, for the daily once-in-20-hours rule | `perf-store.ts` | none |
| `perfimport:{scope}` | json | Latest campaign CSV import: file name, detected platform, metric, row counts, date range, totals, top and bottom three, findings with sample and confidence. No raw rows | `perf-store.ts` | none (replaced on each upload) |
| `storesales:{scope}` | json | Latest store sales snapshot (Salla, Shopify or Zid, whichever was synced last): 30-day order count, revenue by currency, canceled count, open abandoned carts and their value, top products. Totals only, no customer data | `store-sales.ts` | none (replaced on each sync) |
| `connlock:{scope}:{provider}` | string | Held while a connector token is refreshed, so two requests cannot spend one single-use refresh token | `connectors/fresh.ts` | 30 s |
| `profile:{scope}` (written) / `profile:{email}` (read by cron, deleted by wipe) | json | `{emails: all\|important\|none}` | `api/profile/route.ts:21,40`, `api/cron/daily/route.ts:41`, `account.ts:19` | none |
| `notifs:{email}` | json | Up to 50 notifications | `notifications.ts:16` | none |
| `notifseen:{email}:{fingerprint}` | flag | Follow-up dedupe (the 80% cap warning uses `agentcap80:{scope}:{agent}:{YYYY-MM}` for 35 days; a routine's run `routine:{scope}:{id}:{period}` for 8 or 35 days; `wipeAccount` deletes these two for this and the previous month or period, the others expire within a week) | `notifications.ts:32` | `ttlDays` (default 3 d) |
| `notified:{email}:{key}` | string | Once-only email guard (`nudge1`, `lifecycle:dayN`) | `notify.ts:20` | none |
| `mcptoken:{token}` | string | Email for a personal MCP token (no TTL, `mcp.ts:8`) or an OAuth access token (30 d, `oauth.ts:64`) | `mcp.ts`, `oauth.ts` | none / 30 days |
| `mcpgrant:{email}:{id}`, `mcpgrants:{email}` | json / set | One OAuth grant per connected app: client name, scope, dates and the live token pair, so a revoke deletes both | `oauth.ts` | 90 days / none |
| `mcptoken-of:{email}` | string | The current personal MCP token in clear | `mcp.ts:9` | none |
| `oauthclient:{client_id}` | json | Registered OAuth client (may hold `client_secret` in clear) | `oauth.ts:40` | none |
| `oauthcode:{code}` | json | Authorization code payload | `oauth.ts:49` | 10 min |
| `oauthrefresh:{token}` | json | `{email, client_id, scope, grant}` | `oauth.ts:65` | 90 days |
| `ref:{CODE}` | string | Referral code to email | `referral.ts:13` | none |
| `referrals:{email}` | list | Referred signups | `referral.ts:27` | none |
| `referredBy:{email}` | string | Referrer email | `referral.ts:28` | none |
| `shared:{email}:{platform}` | string | One-time share reward flag | `api/referral/share/route.ts:15` | none |
| `usage:{email\|_all}:{YYYY-MM}:{in\|out\|calls\|usd_micro\|kind:*\|agent:{id}:calls\|agent:{id}:usd_micro}` | int | Model usage counters (also `golden@nashr.internal`); the full list per month is `usageMonthKeys` | `usage.ts` `meter` | none |
| `ev:{date}:{event}` | int | Daily event counts | `track.ts:25` | none |
| `active:{d\|w\|m}:{period}` | set | Active emails per day, ISO week, month | `track.ts:27-29` | none |
| `uev:{email}:{event}`, `ulast:{email}`, `ufirst0:{email}:{event}` (and transient `ufirst:`) | int / string | Per-user analytics | `track.ts:30-40` | none |
| `fblog:{scope}` | list | Chat thumbs with timestamp and the owner's reason; counted inside the report window. Per brand since 2026-09-21 (was per account). The legacy `fb:{email}:{agent}:{up\|down}` counters are no longer written; `wipeAccount` deletes both. Since 2026-09-29 the newest 5 thumbs-down reasons of the last 30 days reach that agent's chat prompt (`feedbackFor` with `chat`), never generation | `evals.ts` `recordThumb`, `thumbsIn`; `feedback.ts` | none |
| `golden:runs`, `golden:run:{id}`, `golden:lock` | list / json / lock | Golden set history and mutex | `golden.ts:148,183,219` | lock 300 s |
| `admin:log` | list | Founder action audit log | `api/admin/*` | none |
| `deleted-accounts` | list | `{email, at}` tombstones | `account.ts:20` | none |
| `support-tickets` | list | Support and contact tickets | `api/support/route.ts:11` | none |
| `affiliate-applications` | list | Affiliate applications | `api/affiliates/route.ts:9` | none |
| `integration-requests`, `integration-votes:{name}` | list / int | Integration requests | `api/integrations/route.ts:20-21` | none |
| `wish:votes:{itemId}` | set | Account emails that voted for a wishlist item. `itemId` is checked against the seeded ids in `changelog.ts` and the promoted ids in `wish:items` before any key is built; the email is the session's (2026-09-29) | `wishlist.ts` | none |
| `wish:mine:{email}` | set | Item ids this account voted for, so the page reads the viewer's votes in one call; deleted with the account, whose votes are taken back first | `wishlist.ts`, `account.ts` | none |
| `wish:items` | hash | id `w-{8 hex}` to `{id, title: {ar, en}, area?, at}`: suggestions the founder promoted, under a title the founder wrote | `wishlist.ts` | none |
| `wish:status` | hash | item id to `planned` / `in_progress` / `shipped`; missing means planned | `wishlist.ts` | none |
| `wish:hidden` | set | Seeded item ids the founder removed from the public list (seeded items live in code and cannot be deleted) | `wishlist.ts` | none |
| `wish:suggestions` | list | `{id, email, text, lang, at}` suggestions awaiting review. Never read by a public route; entries of a deleted account are removed | `wishlist.ts` | none |
| `rate:wishvote:{email}`, `rate:wishsuggest:{email}` | int | Wishlist vote (60 per hour) and suggestion (5 per day) allowances, through `allow()` | `api/wishlist/*` | 1 h / 24 h |
| `rate:tool:{ip}`, `toolusage:{slug}` | int | Free tool anonymous daily allowance (through `allow()`, platform IP), per-tool usage | `api/tools/[tool]/route.ts` | 24 h / none |
| `waitlist:entries`, `waitlist:emails` | list / set | Waitlist (direct Upstash client, bypasses `db.ts`) | `api/waitlist/route.ts:4-5` | none |

Bounded lists (2026-09-18): `pushCapped` in `db.ts` trims on write. Caps in `CAPS`: chat threads 400 messages, `admin:log` 2000, `support-tickets` / `affiliate-applications` / `integration-requests` 2000, `fblog:{scope}` 500, `prefs:{scope}` 100, `decisions:{scope}` 500, `wish:suggestions` 500. The task id list `tasks:{scope}` is never trimmed (owner data); `listTasks` reads the newest 200 full tasks **plus every id in `pending:{scope}`** (approvals inbox, MCP `list_inbox`, founder user card). That second half is what stops the sidebar badge from counting work the inbox cannot show: past 200 tasks an owner used to see "Approvals 50" above an inbox holding none of them. Consequences worth knowing: the pending chip is exhaustive while the approved and rejected chips are a recency window, a buried item leaves the list once it is decided (nothing is lost — `listLite` and the reports still see it), and the payload is bounded by 200 + the backlog rather than by the size of the workspace. `pendingCount` and `listTasks` share one `pendingIds` read, so they cannot drift; a pending id whose task record is gone is cleared by that read rather than waiting for the daily reconcile. The chat page's "waiting for you" card is a separate 90-day recency view of the same queue and is deliberately not exhaustive.

## 4. Request lifecycles

### (a) Marketing page
1. Browser requests `/`. `proxy.ts:19` redirects to `/{lang}`. Other marketing paths do not match the proxy matcher and go straight to the route.
2. `src/app/[lang]/layout.tsx` and the page render on the server from static dictionaries. No session lookup, no Redis access.
3. Public forms call `/api/support`, `/api/affiliates`, `/api/tools/{tool}` from the browser. Only the tools route calls a model (anonymous limit 5 per IP per day, `api/tools/[tool]/route.ts:15-20`).

### (b) Authenticated app page
1. Request to `/{lang}/app/...` matches the proxy, which sets `x-pathname` (`proxy.ts:27`).
2. `app/layout.tsx:23` calls `currentUser()`: reads cookie `nashr_session`, loads `session:{token}`, loads `user:{email}`, returns `null` when missing or `suspended`, then attaches `brandId` and `scope` from `activebrand:{email}` (`auth.ts:93-105`).
3. Anonymous and not a public path: redirect to `/{lang}/app/login` (`layout.tsx:24`). The redirect is skipped when `x-pathname` is empty.
4. Each page repeats its own guard (`currentUser()` then `redirect`) and reads data with `sc(u)` or, on several pages, `u.email` (see `permissions.md` section 2).
5. Client components then call JSON APIs with the same cookie.

### (c) Streaming chat turn with a tool call that generates content
1. `ChatPanel` posts `{text, conv, agent, stream:true}` to `POST /api/chat` with header `x-lang` (`src/components/app/ChatPanel.tsx:155`).
2. Route checks `currentUser()` (`api/chat/route.ts:23`), trims text to 4000 chars, validates `agent` with `isAgentId`, opens a `ReadableStream` SSE response with a 10 s `: ping` heartbeat (`:45-49`).
3. `chat()` (`src/lib/chat.ts:156`): pushes the user message to `chat:{scope}[:{conv}]`, loads brand, this agent's preferences (`listPreferencesFor`), memory files, file names, connections, last 16 messages and the agent's recent feedback (`feedbackFor` with chat thumbs, in the uncached block), builds the system prompt (`:94`), and calls `client.messages.stream` with `claude-opus-5` and the nine tools (`:185`). Usage is metered (`:187`).
4. The model returns a `tool_use` for `generate_content` or `draft_items`. `runTool` (`:219`): requires a brand, loads governance, rejects expired trials (`:227`), `charge(user.email, cost, {scope, agent: agentForTask(type), cap: gov.agentCaps[agent]})` under `lock:user:{email}` (`credits.ts`), calls `generate()` (`noor.ts:138`: Opus generation, then Sonnet reviewer `critique`, optional dash stripping). At the agent's monthly cap the tool returns a sentence and pushes `limit:agent_cap`, and the reply carries `limit: "agent_cap"`. On a thrown error the credits are refunded with the charge's receipt, which also lowers the agent's counter, and the error becomes an `is_error` tool result.
5. Each item is saved as `task:{scope}:{id}` with status `approved` when `gov.autoApprove[type]` else `pending` (`chat.ts:241`), id pushed to `tasks:{scope}`. `judgeLater` schedules scoring after the response (`judge.ts:90`), which later writes `quality` on the task and may push a notification.
6. Tool result goes back to the model (up to 5 turns). The final text is pushed to history with `items` cards and sent as `{type:"message", message, credits, limit}` (`api/chat/route.ts:54`). `track(email,"chat")` and `touchConversation` run before the final event.
7. If the client disconnects, work continues and the reply is still saved (`api/chat/route.ts:47`).

### (d) Cron run
1. Vercel Cron issues `GET /api/cron/{daily|weekly|golden|routines}` with `Authorization: Bearer $CRON_SECRET`.
2. Route compares the header to the env value with `sameSecret` (`src/lib/rate.ts`); 401 otherwise or when the variable is unset.
3. `allUsers()` (`schedule.ts:157`) expands every email in `users:all` into one `User` per active brand with `scope` set, skipping `suspended` accounts.
4. Daily: `renewIfDue`, nudge email, `runLifecycle`, `runDaily`, `followUps`, optional brief email. Weekly: `runWeekly` per scope, charging credits and refunding on failure. Golden: `runGolden("cron")` under `golden:lock`. Routines: `dueRoutines` turns the users into (scope, routine) items that are on and due, and `runRoutine` runs each, charging the owning agent and refunding on failure.
5. JSON summary is returned; weekly returns a map keyed by account email (`cron/weekly/route.ts:21`).

## 5. Trust boundaries

| Boundary | What crosses it | Controls present in code |
|---|---|---|
| Browser to Vercel function | Cookies `nashr_session`, `nashr_admin`, `nashr_return`, `nashr_impersonate` (all `httpOnly`, `sameSite=lax`, `secure` in production, `path=/`), `nashr_lang` (client-set, not httpOnly); JSON bodies; query strings | Session lookup per request; no CSRF token (relies on `sameSite=lax` and JSON bodies); input length clamps per route; rate limits only on forgot, reset, admin key login, and anonymous free tools. `clientIp` trusts the first `x-forwarded-for` entry (`rate.ts:12`). |
| Vercel function to Redis | Every record, including password hashes, session tokens (clear), personal MCP tokens (clear, both directions), OAuth client secrets (clear), encrypted connector credentials | TLS REST token from env. Tenant isolation is purely by key naming (scope prefix). No Redis ACL separation. |
| Vercel function to model provider (Anthropic) | Brand file, workspace memory files, owner preferences, the owning agent's recent feedback (decision counts, typed reasons, judge notes, chat thumbs-down reasons), chat history, crawled site text, imported product text, task bodies | Recent feedback is escaped with `asData` inside `<recent_feedback>`, labelled as data, capped in count and length, and only in the uncached prompt block (`feedback.ts`). Model output is parsed as JSON or text; tool inputs are schema-constrained with `strict: true` (`chat.ts:42`) but not re-validated server-side except where noted. Content from crawled sites and imported catalogs enters prompts and the `products.md` memory file, so third-party text can influence agent behaviour including tool calls. |
| Vercel function to third-party platform APIs | Connector credentials (decrypted in memory), content to publish, user-supplied base URLs | Credentials encrypted at rest with AES-256-GCM, key = SHA-256 of `CONNECT_SECRET`, falling back to `WAITLIST_ADMIN_KEY`, then to a fixed dev string (`connectors/store.ts:13-16`). Base URLs for WordPress, WooCommerce, Odoo, PrestaShop and crawl/catalog targets are user-supplied and fetched server-side with no host allow-list or private-range check. |
| Vercel function to email (Resend) and fal.ai | Recipient address, email text; image prompt | API keys from env. |
| External MCP client to `/api/mcp` and OAuth server | Bearer tokens `nashr_...`; OAuth client registration, codes, PKCE verifiers, refresh tokens | `userFromBearer` (`mcp.ts:20`); open dynamic client registration; PKCE S256 required at approve and token; redirect URI exact match; CORS `*` on MCP and OAuth endpoints. |
| Vercel Cron to function | `CRON_SECRET` bearer | Header equality check. |
| Founder to console | `WAITLIST_ADMIN_KEY` (cookie, header `x-admin-key`, or `?key=`) or a founder session | `isAdmin` / `isAdminCookie` (`auth.ts:114,128`); see `permissions.md` section 4. |
