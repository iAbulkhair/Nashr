# Brand-scope map (research, read-only)

Repo: /Users/ihejazy/projects/nashr/.claude/worktrees/brand-parts-bc-29277a
Existing plan: docs/superpowers/plans/2026-10-20-brand-url.md (spec: docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md Part C)

Legend. Auth: CU = currentUser(); H-user = handler({auth:"user"}) (scope = sc(u) is injected, src/lib/api-handler.ts ~109,129); CRON = CRON_SECRET bearer; ADMIN = isAdmin/founder/staff; PUB = public/webhook/token.
BRAND = reads/writes brand-scoped data (needs brand header). ACCOUNT = account-level.

## 0. Headline findings

1. 167 route.ts files. 60 call `sc(` literally (58 browser/user + cron/evening + cron/stores). 5 more are scoped ONLY through handler() with no literal `sc(`: brand, brand/proposals/[id], conversations, files, tasks. A grep for `sc(` misses them. (activity, activity/export, files/proposals/[id] use handler AND literal sc.) wishlist/suggest and wishlist/vote use handler but are ACCOUNT.
2. Scope-bypassing server paths with no `sc(` literal: api/mcp/route.ts uses `user.scope ?? user.email` (lines 128,154,158,162,166,179) from userFromBearer (src/lib/mcp.ts:71-115, uses the server-stored active brand); cron/daily, cron/routines, cron/weekly use `u.scope ?? u.email`. Not browser callers; no header possible. They keep acting on the server-stored active brand.
3. Active brand today is server-side per person+account (`activebrand:{pid}:{acct}`; src/lib/brands.ts activeBrandId/activeBrandIn/setActiveBrandIn/scopeFor; auth.ts ~716-840 resolveIds sets u.brandId/u.scope). POST /api/brands {switch} writes it.
4. Mixed / conflicting items needing a decision (details in section 1.2):
   - PUT /api/profile: account-only for name/lang/phone, brand for BRAND_FIELDS and `emails` (route.ts:22,108-206).
   - PUT /api/notifications/prefs: writes profile:{sc(u)} (route.ts:26) but UI is the account-level settings/notifications page, whose page.tsx also calls readPrefs(sc(u), u.email). Conflicts with plan R-C6 (only brand/connections/governance move under b/) and with the plan's scan test "pages outside b/ call no sc(".
   - POST /api/brands switch (account route, mutates active brand).
   - GET /api/account/export calls sc only to mark the active brand (src/lib/privacy-export.ts:123).
5. Header-less (native navigation) endpoints that cannot carry x-thakeen-brand: window.location to /api/connect/{id}/start (IntegrationsPanel:165,309) and its callback (brand rides in saved OAuth state, st.email = sc(u)); <a href> to /api/tasks/{id}/pptx (Inbox:490, ReportsPanel:298), /api/activity/export (ActivityPanel:143), /api/secretary/series/{id}/export (todo/page.tsx:71), CalendarLinkCard startHref (:46). Also account ones: /api/account/export (DangerZone:57), /api/auth/google/start (AuthForm:53). Native forms: ConsentForm:31, staging-access/page.tsx:28, ImpersonationBanner:47.
6. Shell (layout) runs on account pages without /b/ and calls BRAND routes: WorkspaceContext GET /api/tasks?count=pending (:53) and GET /api/conversations (:55); Sidebar POST /api/conversations (:55). The layout server component also reads getBrand(sc(user)) and pendingCount(sc(user)) on every page (layout.tsx ~70).
7. Settings tabs are SUB-ROUTES (not query params): /{lang}/app/settings/{account|security|notifications|brand|brands|members|billing|connections|governance|danger} (src/lib/settings-nav.ts SETTINGS_SECTIONS, settingsHref). settings/page.tsx is an index list; settings/layout.tsx has SettingsNav + SettingsBack (no fetch).
8. Tests: 40 vitest files read page files by path (tests/uiux-phase3.test.ts, tests/reskin-app.test.ts, tests/topup-payments.test.ts ...) plus tests/scope-usage.test.ts and tests/multi-org-scans.test.ts scan sources. e2e (section 5) lists direct API mutations and /app navigations.

## 1. API routes

### 1.1 Table (full machine scan in Appendix A: path|methods|auth|sc count|scopeVar)

Classification by group. "sc" = literal calls; "H" = handler scope only.

BRAND (scoped data):
| route | methods | auth | calls sc |
|---|---|---|---|
| activity | GET | H-user | yes + H |
| activity/export | GET | H-user | yes + H (csv; link navigation) |
| brand | GET, PUT | H-user | H only |
| brand/proposals/[id] | POST | H-user | H only |
| brief | GET | CU | yes (no browser caller) |
| catalog | POST | CU | yes |
| chat | GET, POST | CU | yes (5) |
| chat/feedback | POST | CU | yes |
| chat/spend/[id] | POST | CU | yes (via lib/spend-proposals.ts:106) |
| connect | GET | CU | yes |
| connect/[provider] | POST, DELETE | CU | yes (39); actions import_products, select_page, select_org, post_as, select_ad_account, sync_ads, sync_sales, select_property, refresh |
| connect/[provider]/key | POST | CU | yes |
| connect/[provider]/start | GET | CU | yes (navigation; stores email: sc(u) in OAuth state) |
| connect/[provider]/callback | GET | CU + saved state | sc=0, scope from state st.email; redirects to /{lang}/app/{todo|integrations}?.. (:47) |
| conversations | GET, POST, PATCH, DELETE | H-user | H only |
| drives | GET, POST, DELETE | CU | yes (9) |
| files | GET, PUT, DELETE | H-user | H only |
| files/proposals/[id] | POST | H-user | yes + H |
| generate | POST | CU | yes |
| governance | GET, PUT | CU | yes |
| governance/rollback | POST | CU | yes |
| handoffs/[id], /run, /decline | GET; POST; POST | CU | yes |
| instructions | GET, PUT | CU | yes |
| instructions/activate, discard, restore, test, refs/import, refs/search, proposals/[id] | POST | CU | yes |
| instructions/history | GET | CU | yes |
| instructions/refs | GET | CU | yes (no browser caller) |
| media/[jobId] | GET | CU | via lib/media/start.ts |
| media/upload | POST | CU | yes |
| models | GET, PUT | CU | yes (PUT checks b.id === u.brandId, :141) |
| onboard | POST | CU | yes (+ u.brandId for onboardCost) |
| onboard/confirm | POST | CU | yes (+ u.brandId) |
| onboard/plan | GET, POST | CU | yes (wsKey.onboardPlan(sc(u))) |
| performance | GET, POST, DELETE | CU | yes |
| publish/[id] | POST | CU | yes |
| schedule | GET, PUT, POST | CU | yes |
| secretary | GET, POST | CU | yes |
| secretary/[id] | PATCH | CU | yes |
| secretary/away | GET, PUT, DELETE | CU | yes |
| secretary/away/proposals/[id] | POST | CU | yes |
| secretary/booking | GET, POST, DELETE | CU | yes |
| secretary/calendar | GET, PUT | CU | yes |
| secretary/calendar-link | GET, PUT, DELETE | CU | yes |
| secretary/calendar-link/calendars | GET | CU | via lib/secretary-cal-routes.ts:27 |
| secretary/feed | GET, POST, DELETE | CU | yes |
| secretary/meeting/[id] | GET, DELETE | CU | via lib/secretary-meeting.ts |
| secretary/meeting/[id]/approve, /propose | POST | CU | via lib/secretary-meeting.ts |
| secretary/series/[seriesId]/export | GET | CU | yes (link navigation) |
| secretary/series/[seriesId]/keep | PUT | CU | yes |
| secretary/walk | GET, POST | CU | yes |
| tasks | GET | H-user | H only |
| tasks/[id] | PATCH | CU | yes |
| tasks/[id]/image, /video | POST | CU | via lib/media/start.ts |
| tasks/[id]/pptx | GET | CU | yes (link navigation) |
| mcp | GET, POST | bearer/OAuth | no literal; user.scope (non-browser) |
| cron/evening, cron/stores | GET/POST | CRON | yes, per user (non-browser) |

ACCOUNT routes that touch sc (explanations):
| route | methods | auth | why sc | note |
|---|---|---|---|---|
| profile | GET, PUT | CU | GET reads profile:{sc(u)} + getBrand(sc(u)); PUT :108-206 touches sc only for BRAND_FIELDS (business, products, audience, tone, valueProp, website, sitemap, social_*; writeBrand under withBrandLock(sc(u)) ~186) or `emails` (db.set profile:{sc(u)}, :177) | MIXED. Callers: AccountSettings (name/lang/phone, account), OnboardCards:79 (phone only, account), BrandExtras:57 via saveProfile (brand fields). Needs header only for brand fields/emails; GET is brand when brand fields are read. |
| notifications/prefs | PUT | CU role profile.account | db.set(profileKey(sc(u)),...) :26 | per-brand prefs stored, UI on account page settings/notifications. Decision needed (move page under b/ or ACCOUNT_SC_API with reason). |
| account/export | GET | CU | privacy-export.ts:123 activeScope = sc(u) only marks active brand; exports all brands | ACCOUNT |
| brands | GET, POST | CU | sc=0; uses scopeFor(acct(u), b.id), u.brandId, setActiveBrandIn (switch/add/rename/archive) | ACCOUNT; switch writes server-side active brand |
| cron/daily, cron/routines, cron/weekly | GET/POST | CRON | u.scope ?? u.email | non-browser |

ACCOUNT (sc=0): account/2fa, account/email, account/google, account (PATCH/DELETE), account/sessions; billing/chat-overflow, billing/checkout, billing/renewal, billing/status, billing/paymob/webhook (PUB HMAC); integrations (GET ADMIN, POST CU); mcp/grants, mcp/token, oauth/approve (CU), oauth/token|register|meta|resource (PUB); notifications (GET/POST), notifications/digest (PUT); partner, partner/code, referral, referral/share; support (public/optional user, GET ADMIN); team, team/invite, team/leave, team/member, team/accept (PUB token + getUser); tools/[tool] (public); wishlist/suggest, wishlist/vote (H-user, no scope), waitlist, affiliates; auth/* (forgot, google start/callback, login, login/mfa, logout, reset, signup, verify/check|email|send); founding/seats; health (CRON); shopify/compliance (PUB HMAC); staging-access; secretary/booking/[token] (PUB token); secretary/feed/[token] (PUB token feed); media/hook/[provider] (webhook signature); ops/summary, ops/telegram, ops/telegram/callback; cron/golden, cron/media, cron/secretary and other cron/*; admin/* (~33 routes: ADMIN/staff session; admin/impersonate POST is cookie/native form; admin/staff/login*|setup public staff sign-in).

### 1.2 Notes
- Helper-based sc: lib/secretary-cal-routes.ts:27, lib/secretary-meeting.ts, lib/media/start.ts, lib/spend-proposals.ts:106, lib/x-stats.ts:83, lib/privacy-export.ts:123, lib/external-drafts.ts:71 (MCP), lib/agent-scope.ts:260.
- No-browser-caller BRAND routes: brief GET, instructions/refs GET.
- Client helper chokepoints: postJson (src/lib/auth-client.ts:16), useOneWrite.send (src/components/app/useOneWrite.ts:43), call() in TeamPanel:36 / InstructionsPanel:134 / MeetingPanel:79-85, post() in PaymobBilling:55, adminFetch (src/lib/admin-fetch.ts:31), saveProfile/readProfile (settings/profileSave.ts:22,38). There is no global fetch wrapper.

## 2. Pages under src/app/[lang]/app (excluding admin)

Page-level sc( use (server): page.tsx, activity, calendar, chat, conversations, files, generate, instructions, reports, settings/brand, settings/governance, settings/notifications (surprise), start, tasks, todo.

BRAND pages and their client fetches:
- page.tsx (inbox root): Inbox: POST /api/publish/{id} (:161), PATCH /api/tasks/{id} (:254), fetch(x.videoUrl) (:203), link /api/tasks/{id}/pptx (:490). DriveExport: GET /api/drives (:12), POST /api/drives (:47). MediaControls: GET /api/media/{id} (:72), POST /api/tasks/{id}/{image|video} (:207).
- chat: ChatPanel: GET /api/handoffs/{id} (:137,159); POST /handoffs/{id}/run (:175), /decline (:208); POST /api/brand/proposals/{id} (:286); POST /api/files/proposals/{id} (:354); POST /api/instructions/proposals/{id} (:407); POST /api/secretary/away/proposals/{id} (:467); POST /api/chat/spend/{id} (:534); GET /api/conversations (:668,670); POST /api/onboard (:694); POST /api/conversations (:731); POST /api/chat stream (:774); GET /api/chat?conv= (:810); POST /api/chat/feedback (:838). ApprovalCard: PATCH /api/tasks/{id} (:56). ModelPicker: GET (:50), PUT (:67) /api/models. OnboardCards: GET/POST /api/onboard/plan (:44,48); PUT /api/profile {phone} (:79, account-only).
- conversations: no fetch (links). calendar: no fetch.
- files: FilesPanel: POST /api/catalog (:54), PUT /api/files (:82), DELETE /api/files?name= (:97). LibraryPanel: GET /api/drives (:26), POST /api/media/upload (:81), PUT /api/files (:103), POST /api/drives (:117,128), DELETE /api/drives?name= (:142). DriveExport as above.
- generate: GeneratePanel POST /api/generate (:34).
- inspo: InspoPanel POST /api/chat (:35).
- instructions: InstructionsPanel via call(): PUT /api/instructions (:170), POST /activate (:185), /discard (:200), GET /history?compare= (:214), POST /restore (:225), /refs/search (:242), /refs/import (:255), /test (:278). page.tsx:33 const scope = sc(u).
- reports: ReportsPanel: POST /api/generate (:63,321), POST /api/connect/{p} sync_sales (:333), link pptx (:298). PerformanceImport: POST /api/performance (:71), POST /api/connect/{p} sync_ads (:87), DELETE /api/performance (:97). SiteStats: POST /api/connect/google select_property (:56). RefreshButton: POST /api/connect/{path} (:97).
- start: StartLaunch (via DictionaryStart): POST /api/onboard/confirm (:63), PUT /api/brand (:81); redirects to /app if a brand exists. BrandsPanel pushes hard-coded /${lang}/app/start after add (:73).
- tasks: TasksPanel PUT /api/schedule (:76), POST /api/schedule (:93,113).
- todo: TodoPanel: POST /api/secretary or PATCH /api/secretary/{id} (:206), PATCH (:241, keepalive), GET/POST /api/secretary/walk?lang= (:249), PATCH /api/tasks/{id} or /api/secretary/{id} (:267). WorkingDaysPanel PUT /api/secretary/calendar (:122). AwayPanel PUT/DELETE /api/secretary/away (:48). BookingCard GET (:202,226), POST (:235,250), DELETE (:267) /api/secretary/booking. CalendarLinkCard GET /calendars (:285), GET /calendar-link (:302), PUT (:330), DELETE (:349); link /api/connect/{gcal|mscal}/start (:46). FeedCard GET (:119), POST (:141), DELETE (:149) /api/secretary/feed. MeetingPanel GET base (:66), POST base/propose (:102), /approve (:115), DELETE base (:135); base=/api/secretary/meeting/{itemId} (:58). SeriesPanel PUT /api/secretary/series/{id}/keep (:43); export link todo/page.tsx:71.
- activity: ActivityPanel GET /api/activity?.. (:51), link /api/activity/export (:143).
- settings/brand: BrandForm PUT /api/brand (:66); ModelPicker /api/models; BrandExtras via saveProfile PUT /api/profile with brand fields (:57), GET /api/profile via readProfile.
- settings/connections: IntegrationsPanel: GET /api/connect (:65); POST /api/integrations (:71, ACCOUNT request); DELETE /api/connect/{id} (:93); POST /api/connect/{id}/key (:105); POST /api/connect/{id} import_products (:114); POST /api/connect/meta select_page (:121); POST /api/connect/linkedin select_org (:131), post_as (:141); POST /api/connect/{provider} select_ad_account (:151); navigations to /api/connect/{id}/start (:165,309).
- settings/governance: GovernancePanel PUT /api/governance (:108), POST /api/governance/rollback (:135), POST /api/handoffs/{id}/decline (:167).

ACCOUNT pages:
- help: HelpCenter POST /api/support (:33), body page: location.pathname; also public.
- notifications: NotificationsPanel POST /api/notifications (:31). Page reads listNotifs(acct(u)) (account-wide). Notification hrefs are server-made and point at brand pages; Notif has no brand id.
- mcp: McpPanel GET/POST/DELETE /api/mcp/token (:18,26,29), GET/DELETE /api/mcp/grants (:19,22). Account-level, but tokens act on the server-stored active brand.
- refer: ReferPanel GET/POST /api/referral/share (:15,24). partner: PartnerPanel PUT /api/partner (:46).
- join: JoinForm POST /api/team/accept (:50,79), POST /api/auth/logout (:64). verify: VerifyForm postJson /api/auth/verify/*. login/signup/forgot/reset: AuthForm postJson /api/auth/*.
- settings/account: AccountSettings PUT /api/profile {name|lang|phone}; EmailChange /api/account/email (:36).
- settings/security: SecuritySettings PATCH /api/account (:57), POST /api/account/sessions (:66); DeviceList GET/DELETE /api/account/sessions (:39,60); GoogleLink GET/POST /api/account/google (:34,54); TwoStepSettings /api/account/2fa (:55).
- settings/billing: PaymobBilling POST /api/billing/checkout (:73), /renewal (:106,119), GET /status (:176); ChatAllowanceCard POST /billing/chat-overflow (:60); PartnerCodeForm POST /api/partner/code (:33).
- settings/members: TeamPanel GET /api/team (:83); call(): POST /team/invite (:104), PATCH/DELETE /team/member (:117,122), DELETE /team/invite (:126), POST /team/leave (:131).
- settings/danger: DeleteAccountDialog DELETE /api/account (:56); LogoutButton POST /api/auth/logout; link /api/account/export (DangerZone:57).
- settings/brands: BrandsPanel GET /api/brands (:45), POST /api/brands (:51); then navigates /${lang}/app/start (:73).
- settings/notifications: MIXED. NotifyPrefsSettings PUT /api/notifications/digest (:87, account) and PUT /api/notifications/prefs (:102, brand via sc(u)); page calls readPrefs(sc(u), u.email).
- settings (index), settings/layout: no fetch.
Page closure data: Appendix D (page-closure.txt).

## 3. Components rendered on every app page (layout.tsx)

Layout server: getBrand(sc(user)), pendingCount(sc(user)) at ~line 70, plus listNotifs(acct(user)). x-pathname checks use endsWith("/billing"|"/start"|"/join"), still valid under b/{id}.
| component | fetch | method | route class |
|---|---|---|---|
| WorkspaceProvider (WorkspaceContext.tsx) | /api/tasks?count=pending (:53) | GET | BRAND |
| | /api/notifications?count=1 (:54) | GET | ACCOUNT |
| | /api/conversations (:55) | GET | BRAND |
| Sidebar (Sidebar.tsx) | /api/conversations (:55, newThread) | POST | BRAND (risky, clickable on account pages) |
| NotificationCenter | /api/notifications (:59) GET, {id} (:40) POST keepalive, mark-all (:66) POST | | ACCOUNT |
| LogoutButton | /api/auth/logout (:10) | POST | ACCOUNT |
| ImpersonationBanner | native form /api/admin/impersonate (:47) | POST | public/cookie |
| TrialBanner, InstallHint, LimitModal, LangToggle, ThemeToggle | none (LimitModal links to settings/governance, settings/billing) | | |
Refetch: on path change after 30s staleness and on window events nashr:pending-changed, :unread-changed, :convs-changed, :credits. Risk: on brand pages the header will be sent by every shell fetch; a stale/archived brand id makes currentUser() notFound() the account routes too. Sidebar has hard-coded base=/${lang}/app links (~46,106-176), account menu links (:182-187), brand header link to settingsHref(lang,"brands"), active() uses path.startsWith.

## 4. Raw fetch inventory

120 literal `fetch("/api...` / fetch(`/api...`) occurrences in 55 files (Appendix B per file counts; Appendix C full list of 130 `fetch(` lines). Top: ChatPanel 16, IntegrationsPanel 9, LibraryPanel 6, McpPanel 5, TodoPanel 4 (+2 variable-URL), 3 each: WorkspaceContext, TasksPanel, ReportsPanel, PerformanceImport, OnboardCards, NotificationCenter, JoinForm, Inbox, GovernancePanel, FilesPanel.
Variable-URL fetches (not matched by literal grep): useOneWrite.ts:43, TodoPanel.tsx:206,267, MeetingPanel.tsx:66,85, InstructionsPanel.tsx:134, Inbox.tsx:203, PaymobBilling.tsx:56, TeamPanel.tsx:36, admin/StaffSignIn.tsx:15.
Helper calls: postJson (auth-client.ts:16): AuthForm:94,203,219,282,341; VerifyForm:109,145,166. adminFetch: admin components.
Not present: sendBeacon, EventSource, WebSocket, axios, SWR.
keepalive: NotificationCenter:40, TodoPanel:241.
<form action="/api...">: ConsentForm:31 (/api/oauth/approve), staging-access/page.tsx:28, ImpersonationBanner:47.
<a href="/api..."> / window.open: Inbox:490, ReportsPanel:298, ActivityPanel:143, DangerZone:57, AuthForm:53, admin Billing.tsx:111. window.location to /api/connect/.../start: IntegrationsPanel:165,309.

## 5. e2e / playwright (playwright.config.ts, testDir ./e2e; projects setup, chromium-desktop, mobile-safari; one next start with APP_ENV=test)

Direct API mutations with a session cookie (request fixture / page.request):
- e2e/auth.setup.ts:18 PUT /api/brand (SEEDED_BRAND)
- e2e/api-guards.spec.ts: PUT /api/brand (:21,39,50); GET /api/tasks (:23); POST /api/generate (:28,41,51)
- e2e/auth-flows.spec.ts:253 page.request.post("/api/onboard")
- e2e/fixtures/accounts.ts: POST /api/auth/verify/send (:48), /verify/check (:54), /signup (:60), /login (:86) (account/public)
Network observation / mocking: auth-flows.spec.ts:55,93,98,243 (expects ["POST /api/onboard/confirm","POST /api/onboard"]); :216,322,332,342 (/api/auth/login, /signup); error-states.spec.ts:19,30 route **/api/generate; :43,59 route **/api/schedule.
Navigations to /ar|en/app/...: a11y.spec.ts:13; error-states.spec.ts:14,28 (/en/app/generate), :40,58 (/en/app/tasks); app-routes.spec.ts:48; auth-flows.spec.ts :78,80,85,100,225-226,246 (/en/app/chat?onboard=),272 (/en/app/settings/danger),286-289; redirects.spec.ts:36,44-47,52,69; reskin-layout.spec.ts:15 (APP_PAGES, 28 paths) and :51; e2e/fixtures/routes.ts:59-92 (route inventory, ownerGoesTo "/app" for /app/start); home.spec.ts:53,66,79.
Full dump: Appendix E (e2e.txt). Vitest: 40 files under tests/ read src/app/[lang]/app/** by path.

## 6. Server-made links into the app (Appendix F has the raw grep)

| file:line | section |
|---|---|
| src/lib/notifications.ts:197 | base `/${lang}/app` for: :213 calendar (due); :217,223,237 inbox (pending/notnow/quality); :227,232 billing; :247 settings/connections |
| src/lib/notifications.ts:335 | todo |
| src/lib/notifications.ts:350 | notifyItem builds `/${lang}/app/${n.href}` for relative hrefs |
| src/lib/notifications.ts:380 | href "governance" (legacy relative; resolved by legacySettingsPath redirect) |
| relative hrefs via notifyItem | run-held.ts:23 "tasks"; hold-sweep.ts:77 "activity"; schedule.ts:212 "" and :222 "?view=notnow"; judge.ts:184,193 ""; team/invite/route.ts:63 and team/accept/route.ts:24 "team" (legacy to settings/members) |
| src/lib/secretary-remind.ts:94; secretary-gcal.ts:220; secretary-evening.ts:209,217; secretary-feed.ts:201; secretary-series.ts:122 (todo?series=) | todo |
| src/lib/secretary-walk.ts:176 | text "(/app)" and "(/app/todo)" |
| src/lib/chat-prompt.ts:84 | system-prompt page list: /app/chat, /app, /app/todo, /app/files, /app/tasks, /app/governance, /app/activity, /app/integrations, /app/mcp, /app/billing, /app/refer, /app/help (also :60,77 mention todo) |
| src/lib/secretary-tools.ts:138,397 | text /app/todo |
| src/lib/notif-digest.ts:76 | /app/notifications (account) |
| src/lib/lifecycle.ts:33,80 (base), :58, :88 | billing and /app (inbox) |
| src/lib/media/jobs.ts:670 | /app (inbox) |
| src/lib/chat-reply.ts:52 | billing |
| src/lib/billing.ts:177 (?paymob=return), :443 | billing |
| src/lib/journey.ts:16-22 | relative: /files, /settings/brand#guard, /calendar, /settings/connections, /mcp |
| src/lib/settings-nav.ts:28,48 | settingsHref and LEGACY_PATH regex |
| src/app/api/cron/daily/route.ts:134 | /app/start; :167-168,175 /app (mail CTA) |
| src/app/api/connect/[provider]/start/route.ts:37,56 | /app/integrations?error= |
| src/app/api/connect/[provider]/callback/route.ts:47 | /app/{todo|integrations}?... |
| src/app/api/auth/forgot/route.ts:50 | reset; team/invite/route.ts:101 join#t=; auth/google/callback/route.ts:28-72 login/signup/settings/security/start/app; admin/users/[email]/route.ts:253 /app; mcp/route.ts:63,78 text /app/mcp; p/[code]/route.ts:32 signup; oauth/authorize/page.tsx:56 login; proxy.ts:105,109 /app; robots.ts:9 |
| src/emails/layout.ts:75 home link; src/emails/samples.ts:15-22 | mail samples |
| src/lib/pwa.ts:17 | PWA_START="/app" |
Notifications store no brand id (Notif type has no scope; scope only used for prefs) so any href to a brand page after the move needs either a brand id at send time or a redirect resolver.
Client hard-coded /app/ links: ~100 occurrences in ~55 files (Sidebar 24, AuthForm 11, HomeSide 8, ChatPanel 7, conversations/page 5).

## 7. Cross-check against the existing plan (2026-10-20-brand-url.md)
- Header x-thakeen-brand set by client api() from location.pathname; proxy strips incoming header on page paths and sets from the b/{id} segment; currentUser() uses it as a selector among the account's active brands, bad selector => notFound(); brand-guard (src/lib/brand-guard.ts, BRAND_GUARD_MODE log then enforce => 409 brand_missing) with ACCOUNT_SC_API list for account routes calling sc.
- Plan says 60 sc routes with 8 using handler(): this scan agrees on 60 literal; the 5 handler-only scoped routes (brand, brand/proposals, conversations, files, tasks) must be in the guard's BRAND set explicitly since they have no `sc(` text.
- ACCOUNT_SC_API candidates from this scan: profile (conditional), notifications/prefs (or move page), account/export, brands. Not sc-callers but at risk: wishlist/* (handler, no scope).
- R-C6 moves settings/brand, connections, governance under b/; settings/notifications page still calls sc(u) and so breaks the plan's own "no sc( outside b/" scan test.
- Shell fetches that hit BRAND routes on non-/b/ pages (section 3) will 409 under enforce mode unless exempted or made path-aware.
- Native-navigation endpoints (section 0 item 5) cannot get the header; they need the brand in the URL/query or a cookie fallback.
- proxy legacySettingsPath 307s old paths (team->members, integrations->connections, onboarding->brand, governance, billing, brands) per settings-nav.ts LEGACY_SETTINGS/LEGACY_PATH.

## Appendix A: API scan (path|methods|auth|sc count|scopeVar)
account/2fa|GET,POST|currentUser|sc=0|scopeVar=0
account/email|GET,POST|currentUser|sc=0|scopeVar=0
account/export|GET|currentUser|sc=0|scopeVar=0
account/google|GET,POST|currentUser|sc=0|scopeVar=0
account|PATCH,DELETE|currentUser|sc=0|scopeVar=0
account/sessions|POST,GET,DELETE|currentUser|sc=0|scopeVar=0
activity/export|GET(user)|handler:user|sc=1|scopeVar=2
activity|GET(user)|handler:user|sc=1|scopeVar=5
admin/2fa|GET,POST|admin|sc=0|scopeVar=0
admin/agent-scope/eval|POST|admin|sc=0|scopeVar=5
admin/agent-scope/modes|POST|admin|sc=0|scopeVar=5
admin/agent-scope/release|POST|admin|sc=0|scopeVar=4
admin/agent-scope|GET|admin|sc=0|scopeVar=4
admin/brand-cap|POST|admin|sc=0|scopeVar=0
admin/client-ip|GET|admin|sc=0|scopeVar=0
admin/evals|GET|admin|sc=0|scopeVar=0
admin/export|GET|admin|sc=0|scopeVar=0
admin/fair-use|POST|admin|sc=0|scopeVar=0
admin/founding|GET,POST|admin|sc=0|scopeVar=0
admin/golden|GET,POST|admin|sc=0|scopeVar=0
admin/impersonate|POST||sc=0|scopeVar=0
admin/integrations|GET|admin|sc=0|scopeVar=0
admin/leads|GET,POST|admin|sc=0|scopeVar=0
admin/log|GET|admin|sc=0|scopeVar=0
admin/login|POST,DELETE|cronSecret|sc=0|scopeVar=0
admin/media|GET|admin|sc=0|scopeVar=1
admin/overview|GET|admin|sc=0|scopeVar=0
admin/partners|GET,POST|admin|sc=0|scopeVar=0
admin/payments/[email]|GET,POST|admin|sc=0|scopeVar=0
admin/plan|GET,POST|admin|sc=0|scopeVar=0
admin/skills|GET,PUT,POST|admin|sc=0|scopeVar=8
admin/staff/bootstrap|POST|admin|sc=0|scopeVar=0
admin/staff/config|POST|admin|sc=0|scopeVar=0
admin/staff/login/code|POST||sc=0|scopeVar=0
admin/staff/login/enrol|POST||sc=0|scopeVar=0
admin/staff/login|POST,DELETE||sc=0|scopeVar=0
admin/staff/me|POST||sc=0|scopeVar=0
admin/staff|GET,POST|admin|sc=0|scopeVar=0
admin/staff/setup|POST||sc=0|scopeVar=0
admin/topups|POST|admin|sc=0|scopeVar=0
admin/users/[email]|GET,POST|admin|sc=0|scopeVar=0
admin/users/[email]/workspace|GET(admin)|handler:admin|sc=0|scopeVar=0
admin/wishlist|GET,POST|admin|sc=0|scopeVar=0
affiliates|POST,GET|admin|sc=0|scopeVar=0
auth/forgot|POST||sc=0|scopeVar=0
auth/google/callback|GET|currentUser|sc=0|scopeVar=0
auth/google/start|GET||sc=0|scopeVar=0
auth/login/mfa|POST||sc=0|scopeVar=0
auth/login|POST|currentUser|sc=0|scopeVar=0
auth/logout|POST||sc=0|scopeVar=0
auth/reset|POST|currentUser|sc=0|scopeVar=0
auth/signup|POST||sc=0|scopeVar=0
auth/verify/check|POST|currentUser|sc=0|scopeVar=0
auth/verify/email|POST|currentUser|sc=0|scopeVar=0
auth/verify/send|POST|currentUser|sc=0|scopeVar=0
billing/chat-overflow|POST|currentUser|sc=0|scopeVar=0
billing/checkout|POST|currentUser|sc=0|scopeVar=0
billing/paymob/webhook|POST||sc=0|scopeVar=0
billing/renewal|POST|currentUser|sc=0|scopeVar=0
billing/status|GET|currentUser|sc=0|scopeVar=0
brand/proposals/[id]|POST(user)|handler:user|sc=0|scopeVar=4
brand|GET(user),PUT(user)|handler:user|sc=0|scopeVar=6
brands|GET,POST|currentUser|sc=0|scopeVar=0
brief|GET|currentUser|sc=1|scopeVar=0
catalog|POST|currentUser|sc=3|scopeVar=0
chat/feedback|POST|currentUser|sc=1|scopeVar=0
chat|GET,POST|currentUser|sc=5|scopeVar=6
chat/spend/[id]|POST|currentUser|sc=3|scopeVar=3
connect/[provider]/callback|GET|cronSecret+currentUser|sc=0|scopeVar=0
connect/[provider]/key|POST|currentUser|sc=5|scopeVar=0
connect/[provider]|DELETE,POST|currentUser|sc=39|scopeVar=3
connect/[provider]/start|GET|currentUser|sc=4|scopeVar=0
connect|GET|currentUser|sc=1|scopeVar=0
conversations|GET(user),POST(user),PATCH(user),DELETE(user)|handler:user|sc=0|scopeVar=9
cron/daily|GET|cronSecret|sc=0|scopeVar=14
cron/evening|GET|cronSecret|sc=2|scopeVar=1
cron/golden|GET|cronSecret|sc=0|scopeVar=0
cron/media|GET|cronSecret|sc=0|scopeVar=0
cron/routines|GET|cronSecret|sc=0|scopeVar=3
cron/secretary|POST|cronSecret|sc=0|scopeVar=0
cron/stores|GET|cronSecret|sc=3|scopeVar=0
cron/weekly|GET|cronSecret|sc=0|scopeVar=1
drives|GET,POST,DELETE|currentUser|sc=9|scopeVar=0
files/proposals/[id]|POST(user)|handler:user|sc=2|scopeVar=3
files|GET(user),PUT(user),DELETE(user)|handler:user|sc=0|scopeVar=9
founding/seats|GET||sc=0|scopeVar=0
generate|POST|currentUser|sc=1|scopeVar=5
governance/rollback|POST|currentUser|sc=2|scopeVar=1
governance|GET,PUT|currentUser|sc=2|scopeVar=1
handoffs/[id]/decline|POST|currentUser|sc=2|scopeVar=4
handoffs/[id]|GET|currentUser|sc=2|scopeVar=4
handoffs/[id]/run|POST|currentUser|sc=2|scopeVar=3
health|GET|cronSecret|sc=0|scopeVar=0
instructions/activate|POST|currentUser|sc=3|scopeVar=0
instructions/discard|POST|currentUser|sc=2|scopeVar=0
instructions/history|GET|currentUser|sc=2|scopeVar=0
instructions/proposals/[id]|POST|currentUser|sc=3|scopeVar=2
instructions/refs/import|POST|currentUser|sc=2|scopeVar=0
instructions/refs|GET|currentUser|sc=3|scopeVar=4
instructions/refs/search|POST|currentUser|sc=2|scopeVar=0
instructions/restore|POST|currentUser|sc=2|scopeVar=0
instructions|GET,PUT|currentUser|sc=5|scopeVar=1
instructions/test|POST|currentUser|sc=4|scopeVar=20
integrations|GET,POST|admin+currentUser|sc=0|scopeVar=0
mcp/grants|GET,DELETE|currentUser|sc=0|scopeVar=0
mcp|GET,POST|bearer-token|sc=0|scopeVar=13
mcp/token|GET,POST,DELETE|bearer-token+currentUser|sc=0|scopeVar=0
media/[jobId]|GET|currentUser|sc=3|scopeVar=1
media/hook/[provider]|POST||sc=0|scopeVar=1
media/upload|POST|currentUser|sc=3|scopeVar=0
models|GET,PUT|currentUser|sc=3|scopeVar=7
notifications/digest|PUT|currentUser|sc=0|scopeVar=0
notifications/prefs|PUT|currentUser|sc=2|scopeVar=1
notifications|GET,POST|currentUser|sc=0|scopeVar=0
oauth/approve|POST|currentUser|sc=0|scopeVar=3
oauth/meta|GET||sc=0|scopeVar=0
oauth/register|POST||sc=0|scopeVar=0
oauth/resource|GET||sc=0|scopeVar=0
oauth/token|POST|cronSecret|sc=0|scopeVar=1
onboard/confirm|POST|currentUser|sc=1|scopeVar=5
onboard/plan|GET,POST|currentUser|sc=3|scopeVar=0
onboard|POST|currentUser|sc=1|scopeVar=34
ops/summary|GET|cronSecret|sc=0|scopeVar=0
ops/telegram/callback|POST|cronSecret|sc=0|scopeVar=0
ops/telegram|POST||sc=0|scopeVar=0
partner/code|POST|currentUser|sc=0|scopeVar=0
partner|PUT|currentUser|sc=0|scopeVar=0
performance|GET,POST,DELETE|currentUser|sc=6|scopeVar=1
profile|GET,PUT|currentUser|sc=6|scopeVar=0
publish/[id]|POST|currentUser|sc=6|scopeVar=2
referral|GET|currentUser|sc=0|scopeVar=0
referral/share|POST,GET|currentUser|sc=0|scopeVar=0
schedule|GET,PUT,POST|currentUser|sc=2|scopeVar=2
secretary/[id]|PATCH|currentUser|sc=2|scopeVar=4
secretary/away/proposals/[id]|POST|currentUser|sc=2|scopeVar=0
secretary/away|GET,PUT,DELETE|currentUser|sc=4|scopeVar=11
secretary/booking/[token]|POST||sc=0|scopeVar=4
secretary/booking|GET,POST,DELETE|currentUser|sc=3|scopeVar=1
secretary/calendar-link/calendars|GET|currentUser|sc=0|scopeVar=10
secretary/calendar-link|GET,PUT,DELETE|currentUser|sc=1|scopeVar=23
secretary/calendar|GET,PUT|currentUser|sc=3|scopeVar=13
secretary/feed/[token]|GET||sc=0|scopeVar=4
secretary/feed|GET,POST,DELETE|currentUser|sc=2|scopeVar=3
secretary/meeting/[id]/approve|POST|currentUser|sc=2|scopeVar=3
secretary/meeting/[id]/propose|POST|currentUser|sc=2|scopeVar=3
secretary/meeting/[id]|GET,DELETE|currentUser|sc=3|scopeVar=6
secretary|GET,POST|currentUser|sc=2|scopeVar=5
secretary/series/[seriesId]/export|GET|currentUser|sc=2|scopeVar=5
secretary/series/[seriesId]/keep|PUT|currentUser|sc=2|scopeVar=4
secretary/walk|GET,POST|currentUser|sc=3|scopeVar=3
shopify/compliance|POST||sc=0|scopeVar=0
staging-access|POST,GET,PUT,PATCH,DELETE|cronSecret|sc=0|scopeVar=0
support|POST,GET|admin+currentUser|sc=0|scopeVar=0
tasks/[id]/image|POST|currentUser|sc=2|scopeVar=0
tasks/[id]/pptx|GET|currentUser|sc=2|scopeVar=0
tasks/[id]|PATCH|currentUser|sc=1|scopeVar=12
tasks/[id]/video|POST|currentUser|sc=2|scopeVar=0
tasks|GET(user)|handler:user|sc=0|scopeVar=3
team/accept|POST||sc=0|scopeVar=0
team/invite|POST,DELETE|currentUser|sc=0|scopeVar=0
team/leave|POST|currentUser|sc=0|scopeVar=0
team/member|PATCH,DELETE|currentUser|sc=0|scopeVar=0
team|GET|currentUser|sc=0|scopeVar=0
tools/[tool]|POST|currentUser|sc=0|scopeVar=0
waitlist|POST,GET|admin|sc=0|scopeVar=0
wishlist/suggest|POST(user)|handler:user|sc=0|scopeVar=0
wishlist/vote|POST(user)|handler:user|sc=0|scopeVar=1

## Appendix B: literal /api fetch count per file
  16 src/components/app/ChatPanel.tsx
   9 src/components/app/IntegrationsPanel.tsx
   6 src/components/app/LibraryPanel.tsx
   5 src/components/app/McpPanel.tsx
   3 src/components/app/WorkspaceContext.tsx
   3 src/components/app/TasksPanel.tsx
   3 src/components/app/ReportsPanel.tsx
   3 src/components/app/PerformanceImport.tsx
   3 src/components/app/OnboardCards.tsx
   3 src/components/app/NotificationCenter.tsx
   3 src/components/app/JoinForm.tsx
   3 src/components/app/GovernancePanel.tsx
   3 src/components/app/FilesPanel.tsx
   2 src/components/app/settings/profileSave.ts
   2 src/components/app/settings/SecuritySettings.tsx
   2 src/components/app/settings/NotifyPrefsSettings.tsx
   2 src/components/app/settings/GoogleLink.tsx
   2 src/components/app/settings/DeviceList.tsx
   2 src/components/app/TodoPanel.tsx
   2 src/components/app/StartLaunch.tsx
   2 src/components/app/ReferPanel.tsx
   2 src/components/app/ModelPicker.tsx
   2 src/components/app/MediaControls.tsx
   2 src/components/app/Inbox.tsx
   2 src/components/app/DriveExport.tsx
   2 src/components/app/CalendarLinkCard.tsx
   2 src/components/app/BrandsPanel.tsx
   2 src/components/app/BookingCard.tsx
   1 src/components/app/settings/TwoStepSettings.tsx
   1 src/components/app/settings/EmailChange.tsx
   1 src/components/app/TeamPanel.tsx
   1 src/components/app/SiteStats.tsx
   1 src/components/app/Sidebar.tsx
   1 src/components/app/RefreshButton.tsx
   1 src/components/app/PaymobBilling.tsx
   1 src/components/app/PartnerPanel.tsx
   1 src/components/app/PartnerCodeForm.tsx
   1 src/components/app/NotificationsPanel.tsx
   1 src/components/app/LogoutButton.tsx
   1 src/components/app/InspoPanel.tsx
   1 src/components/app/GeneratePanel.tsx
   1 src/components/app/FeedCard.tsx
   1 src/components/app/DeleteAccountDialog.tsx
   1 src/components/app/ChatAllowanceCard.tsx
   1 src/components/app/BrandForm.tsx
   1 src/components/app/ApprovalCard.tsx
   1 src/components/app/AdminLogin.tsx
   1 src/components/app/ActivityPanel.tsx
   1 src/components/WishVote.tsx
   1 src/components/WishSuggest.tsx
   1 src/components/ToolForm.tsx
   1 src/components/HelpCenter.tsx
   1 src/components/ContactForm.tsx
   1 src/components/AffiliateForm.tsx
   1 src/app/oauth/authorize/ConsentForm.tsx

## Appendix C: all fetch( lines (src/components, src/app)
src/components/WishSuggest.tsx:21:      const r = await fetch("/api/wishlist/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, lang }) });
src/components/HelpCenter.tsx:33:    const res = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, lang, page: location.pathname }) }).catch(() => null);
src/components/WishVote.tsx:25:      const r = await fetch("/api/wishlist/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, on }) });
src/components/ContactForm.tsx:16:    const r = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: d.email, message, type: kind, page, lang }) }).catch(() => null);
src/components/ToolForm.tsx:29:      const res = await fetch(`/api/tools/${tool.slug}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
src/components/AffiliateForm.tsx:21:    const res = await fetch("/api/affiliates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, consent: true, lang }) }).catch(() => null);
src/components/app/MeetingPanel.tsx:66:    fetch(base, { cache: "no-store" })
src/components/app/MeetingPanel.tsx:85:      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
src/components/app/JoinForm.tsx:50:        const res = await fetch("/api/team/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tok }) });
src/components/app/JoinForm.tsx:64:    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
src/components/app/JoinForm.tsx:79:      const res = await fetch("/api/team/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current, name: name.trim(), password: pw, lang }) });
src/components/app/ActivityPanel.tsx:51:      const res = await fetch(`/api/activity?${q}`);
src/components/app/PartnerCodeForm.tsx:33:      const res = await fetch("/api/partner/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
src/components/app/RefreshButton.tsx:97:      const res = await fetch(`/api/connect/${encodeURIComponent(path)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: ACTION[kind] }) });
src/components/app/CalendarLinkCard.tsx:285:      const r = await fetch("/api/secretary/calendar-link/calendars", { cache: "no-store" });
src/components/app/CalendarLinkCard.tsx:302:    fetch("/api/secretary/calendar-link", { cache: "no-store" })
src/components/app/BrandForm.tsx:66:    const res = await fetch("/api/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, languages: langs, channels }) }).catch(() => null);
src/components/app/DriveExport.tsx:12:    drivesOnce = fetch("/api/drives")
src/components/app/DriveExport.tsx:47:    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", drive: id, url }) }).catch(() => null);
src/components/app/AdminLogin.tsx:44:      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, code }) });
src/components/app/FeedCard.tsx:119:    fetch("/api/secretary/feed", { cache: "no-store" })
src/components/app/useOneWrite.ts:43:      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
src/components/app/InstructionsPanel.tsx:134:      const res = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
src/components/app/NotificationCenter.tsx:40:  const r = await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }), keepalive: true }).catch(() => null);
src/components/app/NotificationCenter.tsx:59:    const r = await fetch("/api/notifications").catch(() => null);
src/components/app/NotificationCenter.tsx:66:    const r = await fetch("/api/notifications", { method: "POST" }).catch(() => null);
src/components/app/ChatAllowanceCard.tsx:60:      const res = await fetch("/api/billing/chat-overflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
src/components/app/McpPanel.tsx:18:    if (canToken) fetch("/api/mcp/token").then((r) => r.json()).then((j) => setExists(!!j.exists)).catch(() => {});
src/components/app/McpPanel.tsx:19:    if (canGrants) fetch("/api/mcp/grants").then((r) => r.json()).then((j) => setGrants(j.grants ?? [])).catch(() => {});
src/components/app/McpPanel.tsx:22:    const r = await fetch(`/api/mcp/grants?id=${id}`, { method: "DELETE" });
src/components/app/McpPanel.tsx:26:    const j = await (await fetch("/api/mcp/token", { method: "POST" })).json();
src/components/app/McpPanel.tsx:29:  async function revoke() { await fetch("/api/mcp/token", { method: "DELETE" }); setToken(""); setExists(false); }
src/components/app/TeamPanel.tsx:36:    const res = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
src/components/app/TeamPanel.tsx:83:      const res = await fetch("/api/team");
src/components/app/InspoPanel.tsx:35:    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ text }) }).catch(() => null);
src/components/app/PartnerPanel.tsx:46:      const res = await fetch("/api/partner", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holder, iban, country, taxNumber, vatRegistered }) });
src/components/app/Inbox.tsx:161:    const res = await fetch(`/api/publish/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, version, ...(repeat ? { again: true } : {}), ...(live ? { live: true } : {}) 
src/components/app/Inbox.tsx:203:        const res = await fetch(url);
src/components/app/Inbox.tsx:254:      const res = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, version: taskVersion(before) }) });
src/components/app/LogoutButton.tsx:10:        await fetch("/api/auth/logout", { method: "POST" });
src/components/app/ModelPicker.tsx:50:    fetch("/api/models", { cache: "no-store" })
src/components/app/ModelPicker.tsx:67:  const r = await fetch("/api/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
src/components/app/OnboardCards.tsx:44:  useEffect(() => { if (demo) return; fetch("/api/onboard/plan").then((r) => r.json()).then((j) => { if (j.ok && Array.isArray(j.plan) && j.plan.length === plan.length) setItems(j.plan); }).catch(() => {}); }, [plan.lengt
src/components/app/OnboardCards.tsx:48:    await fetch("/api/onboard/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: i, added: true }) }).catch(() => {});
src/components/app/OnboardCards.tsx:79:    <form onSubmit={async (e) => { e.preventDefault(); if (v.replace(/\D/g, "").length < 9) return setState("bad"); const r = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, b
src/components/app/ApprovalCard.tsx:56:      const r = await fetch(`/api/tasks/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next, version: taskVersion(item) }) }).catch(() => null);
src/components/app/PaymobBilling.tsx:56:  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
src/components/app/PaymobBilling.tsx:176:      const j = await fetch("/api/billing/status", { cache: "no-store" }).then((x) => x.json()).catch(() => null) as
src/components/app/LibraryPanel.tsx:26:const load = (): Promise<Listing> => fetch("/api/drives").then((r) => r.json() as Promise<Listing>).catch(() => null);
src/components/app/LibraryPanel.tsx:81:    const res = await fetch("/api/media/upload", { method: "POST", body: fd }).catch(() => null);
src/components/app/LibraryPanel.tsx:103:    const res = await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content }) }).catch(() => null);
src/components/app/LibraryPanel.tsx:117:    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", drive: d, q: words }) }).catch(() => null);
src/components/app/LibraryPanel.tsx:128:    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import", drive: d, id: h.id, name: h.name }) }).catch(() => null);
src/components/app/LibraryPanel.tsx:142:    const res = await fetch(`/api/drives?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
src/components/app/SiteStats.tsx:56:      const res = await fetch("/api/connect/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_property", kind, id }) });
src/components/app/ReferPanel.tsx:15:  useEffect(() => { void fetch("/api/referral/share").then((x) => x.json()).then((j) => j.ok && setDone(j.done)); }, []);
src/components/app/ReferPanel.tsx:24:    const j = await fetch("/api/referral/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: id }) }).then((x) => x.json()).catch(() => null);
src/components/app/BookingCard.tsx:202:    fetch("/api/secretary/booking", { cache: "no-store" })
src/components/app/BookingCard.tsx:226:      const r = await fetch("/api/secretary/booking", { cache: "no-store" });
src/components/app/TodoPanel.tsx:206:      const r = await fetch(id === "new" ? "/api/secretary" : `/api/secretary/${id}`, { method: id === "new" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
src/components/app/TodoPanel.tsx:241:    void fetch(`/api/secretary/${row.id}`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "chased" }) }).then(() => router.refresh(), () => {});
src/components/app/TodoPanel.tsx:249:      const r = await fetch(`/api/secretary/walk?lang=${lang}`, next ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "next", key: next }) } : undefined);
src/components/app/TodoPanel.tsx:267:      const r = await fetch(card.kind === "approval" ? `/api/tasks/${card.id}` : `/api/secretary/${card.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
src/components/app/FilesPanel.tsx:54:      const res = await fetch("/api/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
src/components/app/FilesPanel.tsx:82:    const res = await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content, baseAt }) }).catch(() => null);
src/components/app/FilesPanel.tsx:97:    const res = await fetch(`/api/files?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
src/components/app/MediaControls.tsx:72:      res = await fetch(`/api/media/${id}`, { cache: "no-store", signal: ctl.signal });
src/components/app/MediaControls.tsx:207:      res = await fetch(`/api/tasks/${task.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m ? { model: m.id } : {}) });
src/components/app/GeneratePanel.tsx:34:      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
src/components/app/IntegrationsPanel.tsx:65:    const j = await (await fetch("/api/connect")).json();
src/components/app/IntegrationsPanel.tsx:71:    const res = await fetch("/api/integrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
src/components/app/IntegrationsPanel.tsx:93:      const res = await fetch(`/api/connect/${id}`, { method: "DELETE" }).catch(() => null);
src/components/app/IntegrationsPanel.tsx:105:    const res = await fetch(`/api/connect/${keyFor.id}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) }).catch(() => null);
src/components/app/IntegrationsPanel.tsx:114:    const res = await fetch(`/api/connect/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import_products" }) });
src/components/app/IntegrationsPanel.tsx:121:    const res = await fetch("/api/connect/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_page", pageId }) });
src/components/app/IntegrationsPanel.tsx:131:    const res = await fetch("/api/connect/linkedin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_org", org }) });
src/components/app/IntegrationsPanel.tsx:141:    const res = await fetch("/api/connect/linkedin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "post_as", value }) });
src/components/app/IntegrationsPanel.tsx:151:    const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_ad_account", accountId }) });
src/components/app/Sidebar.tsx:55:    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent }) })).json();
src/components/app/WorkspaceContext.tsx:53:  const loadPending = useCallback(() => fetch("/api/tasks?count=pending").then((r) => r.json()).then((j) => { if (j.ok) setPending(j.pending); }).catch(() => {}), []);
src/components/app/WorkspaceContext.tsx:54:  const loadUnread = useCallback(() => fetch("/api/notifications?count=1").then((r) => r.json()).then((j) => { if (j.ok) setUnread(j.unread); }).catch(() => {}), []);
src/components/app/WorkspaceContext.tsx:55:  const loadConvs = useCallback(() => fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) setConvs(j.conversations); }).catch(() => {}), []);
src/components/app/StartLaunch.tsx:63:    const res = await fetch("/api/onboard/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: site, answers }) }).catch(() => null);
src/components/app/StartLaunch.tsx:81:    const res = await fetch("/api/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noSiteBrand(answers, products, audience)) }).catch(() => null);
src/components/app/GovernancePanel.tsx:108:      const res = await fetch("/api/governance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...gov, agentCaps, toolPolicy: fullPolicy(gov.toolPolicy), ...confirm }) });
src/components/app/GovernancePanel.tsx:135:      const send = (confirmAutoHandoff: boolean) => fetch("/api/governance/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmAutoHandoff ? { id, confirmAutoHando
src/components/app/GovernancePanel.tsx:167:      const r = await fetch(`/api/handoffs/${q.id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: q.item }) });
src/components/app/PerformanceImport.tsx:71:      const res = await fetch("/api/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv, file, metric }) });
src/components/app/PerformanceImport.tsx:87:      const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync_ads" }) });
src/components/app/PerformanceImport.tsx:97:    const res = await fetch("/api/performance", { method: "DELETE" }).catch(() => null);
src/components/app/ChatPanel.tsx:137:    const r = await fetch(`/api/handoffs/${id}`).catch(() => null);
src/components/app/ChatPanel.tsx:159:    fetch(`/api/handoffs/${id}`)
src/components/app/ChatPanel.tsx:175:    const r = await fetch(`/api/handoffs/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: n }) }).catch(() => null);
src/components/app/ChatPanel.tsx:208:      const r = await fetch(`/api/handoffs/${id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(n === undefined ? {} : { item: n }) }).catch(() => null);
src/components/app/ChatPanel.tsx:286:    const r = await fetch(`/api/brand/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
src/components/app/ChatPanel.tsx:354:    const r = await fetch(`/api/files/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
src/components/app/ChatPanel.tsx:407:    const r = await fetch(`/api/instructions/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
src/components/app/ChatPanel.tsx:467:    const r = await fetch(`/api/secretary/away/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
src/components/app/ChatPanel.tsx:534:    const r = await fetch(`/api/chat/spend/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
src/components/app/ChatPanel.tsx:668:  useEffect(() => { void fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) { setConvs(j.conversations); if (initialConv) setAgent((j.conversations as Conv[]).find((c) => c.id === initialConv)?.agent 
src/components/app/ChatPanel.tsx:670:  const reloadConvs = useCallback(() => { fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) setConvs(j.conversations); }).catch(() => {}); }, []);
src/components/app/ChatPanel.tsx:694:        const res = await fetch("/api/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: onboardUrl }) });
src/components/app/ChatPanel.tsx:731:    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent: withAgent }) })).json();
src/components/app/ChatPanel.tsx:774:      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ text: m, conv, agent, stream: true }), signal: ac.signal });
src/components/app/ChatPanel.tsx:810:          const j = await (await fetch(`/api/chat?conv=${encodeURIComponent(conv)}`)).json();
src/components/app/ChatPanel.tsx:838:    await fetch("/api/chat/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: m.agent ?? agent, value, reason: value === -1 ? reason : undefined, at: m.at }) });
src/components/app/BrandsPanel.tsx:45:  async function load() { const j = await (await fetch("/api/brands")).json(); if (j.ok) { setBrands(j.brands); setActive(j.active); setCap(Number(j.cap) || 0); setCanUpgrade(!!j.canUpgrade); } }
src/components/app/BrandsPanel.tsx:51:      const res = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
src/components/app/settings/profileSave.ts:22:  const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
src/components/app/settings/profileSave.ts:38:export const readProfile = () => fetch("/api/profile", { cache: "no-store" }).then((x) => x.json() as Promise<{ ok?: boolean; me?: { name: string; lang: Lang }; user?: { phone?: string }; brand?: NonNullable<Profil
src/components/app/ReportsPanel.tsx:63:    const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
src/components/app/ReportsPanel.tsx:321:      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "cart_recovery" }) });
src/components/app/ReportsPanel.tsx:333:    const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync_sales" }) });
src/components/app/TasksPanel.tsx:76:      const res = await fetch("/api/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
src/components/app/TasksPanel.tsx:93:      const res = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: "routine", id }) });
src/components/app/TasksPanel.tsx:113:      const res = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: which }) });
src/components/app/NotificationsPanel.tsx:31:    const r = await fetch("/api/notifications", { method: "POST" }).catch(() => null);
src/components/app/settings/TwoStepSettings.tsx:55:  const res = await fetch("/api/account/2fa", { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
src/components/app/DeleteAccountDialog.tsx:56:    const res = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
src/components/app/settings/DeviceList.tsx:39:  const res = await fetch("/api/account/sessions").catch(() => null);
src/components/app/settings/DeviceList.tsx:60:    const res = await fetch("/api/account/sessions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, password }) }).catch(() => null);
src/components/app/settings/NotifyPrefsSettings.tsx:87:    const res = await fetch("/api/notifications/digest", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ every: digest }) }).catch(() => null);
src/components/app/settings/NotifyPrefsSettings.tsx:102:    const res = await fetch("/api/notifications/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
src/components/app/settings/EmailChange.tsx:36:  const res = await fetch("/api/account/email", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }).catch(() => null);
src/components/app/settings/GoogleLink.tsx:34:  const res = await fetch("/api/account/google").catch(() => null);
src/components/app/settings/GoogleLink.tsx:54:    const res = await fetch("/api/account/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, password: pw, lang }) }).catch(() => null);
src/components/app/settings/SecuritySettings.tsx:57:    const res = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: cur, newPassword: pw }) }).catch(() => null);
src/components/app/settings/SecuritySettings.tsx:66:    const res = await fetch("/api/account/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: confirm }) }).catch(() => null);
src/app/oauth/authorize/ConsentForm.tsx:20:    const res = await fetch("/api/oauth/approve", {
src/components/admin/StaffSignIn.tsx:15:    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });

## Appendix D: page -> client component closure (depth:file fetchcount)
PAGE activity/page.tsx
  1 src/components/app/ActivityPanel.tsx 2
PAGE calendar/page.tsx
PAGE chat/page.tsx
  1 src/components/app/ChatPanel.tsx 16
  2 src/components/app/ApprovalCard.tsx 1
  2 src/components/app/ModelPicker.tsx 2
  2 src/components/app/OnboardCards.tsx 3
  2 src/components/app/WorkspaceContext.tsx 3
PAGE conversations/page.tsx
PAGE files/page.tsx
  1 src/components/app/FilesPanel.tsx 3
  1 src/components/app/LibraryPanel.tsx 6
  2 src/components/app/DriveExport.tsx 2
PAGE forgot/page.tsx
  1 src/components/app/AuthForm.tsx 6
PAGE generate/page.tsx
  1 src/components/app/GeneratePanel.tsx 1
PAGE help/page.tsx
  1 src/components/HelpCenter.tsx 1
PAGE inspo/page.tsx
  1 src/components/app/InspoPanel.tsx 1
PAGE instructions/page.tsx
  1 src/components/app/InstructionsPanel.tsx 9
PAGE join/page.tsx
  1 src/components/app/JoinForm.tsx 3
PAGE login/page.tsx
  1 src/components/app/AuthForm.tsx 6
PAGE mcp/page.tsx
  1 src/components/app/McpPanel.tsx 5
PAGE notifications/page.tsx
  1 src/components/app/NotificationsPanel.tsx 1
  2 src/components/app/NotificationCenter.tsx 3
  2 src/components/app/WorkspaceContext.tsx 3
PAGE page.tsx
  1 src/components/app/Inbox.tsx 4
  2 src/components/app/DriveExport.tsx 2
  2 src/components/app/MediaControls.tsx 2
PAGE partner/page.tsx
  1 src/components/app/PartnerPanel.tsx 1
PAGE refer/page.tsx
  1 src/components/app/ReferPanel.tsx 2
PAGE reports/page.tsx
  1 src/components/app/ReportsPanel.tsx 4
  2 src/components/app/PerformanceImport.tsx 3
  2 src/components/app/SiteStats.tsx 1
  3 src/components/app/RefreshButton.tsx 1
PAGE reset/page.tsx
  1 src/components/app/AuthForm.tsx 6
PAGE settings/account/page.tsx
  2 src/components/app/settings/EmailChange.tsx 1
  2 src/components/app/settings/profileSave.ts 2
PAGE settings/billing/page.tsx
  1 src/components/app/ChatAllowanceCard.tsx 1
  1 src/components/app/PartnerCodeForm.tsx 1
  1 src/components/app/PaymobBilling.tsx 5
PAGE settings/brand/page.tsx
  1 src/components/app/BrandForm.tsx 1
  2 src/components/app/ModelPicker.tsx 2
  2 src/components/app/settings/profileSave.ts 2
PAGE settings/brands/page.tsx
  1 src/components/app/BrandsPanel.tsx 2
PAGE settings/connections/page.tsx
  1 src/components/app/IntegrationsPanel.tsx 11
PAGE settings/danger/page.tsx
  1 src/components/app/settings/DangerZone.tsx 1
  2 src/components/app/DeleteAccountDialog.tsx 1
  2 src/components/app/LogoutButton.tsx 1
PAGE settings/governance/page.tsx
  1 src/components/app/GovernancePanel.tsx 3
PAGE settings/members/page.tsx
  1 src/components/app/TeamPanel.tsx 7
PAGE settings/notifications/page.tsx
  1 src/components/app/settings/NotifyPrefsSettings.tsx 2
PAGE settings/page.tsx
PAGE settings/security/page.tsx
  1 src/components/app/settings/SecuritySettings.tsx 2
  2 src/components/app/settings/DeviceList.tsx 2
  2 src/components/app/settings/GoogleLink.tsx 2
  2 src/components/app/settings/TwoStepSettings.tsx 1
PAGE signup/page.tsx
  1 src/components/app/AuthForm.tsx 6
PAGE start/page.tsx
  2 src/components/app/StartLaunch.tsx 2
PAGE tasks/page.tsx
  1 src/components/app/TasksPanel.tsx 3
PAGE todo/page.tsx
  1 src/components/app/SeriesPanel.tsx 1
  1 src/components/app/TodoPanel.tsx 4
  1 src/components/app/WorkingDaysPanel.tsx 1
  2 src/components/app/AwayPanel.tsx 1
  2 src/components/app/BookingCard.tsx 5
  2 src/components/app/CalendarLinkCard.tsx 5
  2 src/components/app/FeedCard.tsx 3
  2 src/components/app/MeetingPanel.tsx 3
  2 src/components/app/useOneWrite.ts 1
PAGE verify/page.tsx
  1 src/components/app/VerifyForm.tsx 3
  2 src/components/app/LogoutButton.tsx 1

## Appendix E: e2e scan
e2e/a11y.spec.ts:13:const PAGES = ["/ar", "/en", "/ar/pricing", "/en/pricing", "/ar/app/login", "/en/app/signup", "/ar/help"];
e2e/a11y.spec.ts:32:      await page.goto(path, { waitUntil: "load" });
e2e/api-guards.spec.ts:7: * The first block pins a defect that was live: `/api/generate` validated its `type` with `type in TASK_COST`, and `in`
e2e/api-guards.spec.ts:17:test.describe("POST /api/generate validates the task type", () => {
e2e/api-guards.spec.ts:21:    expect((await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } })).ok()).toBe(true);
e2e/api-guards.spec.ts:23:    const credits = async () => ((await (await request.get("/api/tasks")).json()) as { credits: number }).credits;
e2e/api-guards.spec.ts:28:      const res = await request.post("/api/generate", { data: { type: key } });
e2e/api-guards.spec.ts:39:    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });
e2e/api-guards.spec.ts:41:    const res = await request.post("/api/generate", { data: { type: "social" } });
e2e/api-guards.spec.ts:50:    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });
e2e/api-guards.spec.ts:51:    const res = await request.post("/api/generate", { data: { type: "not_a_task_type" } });
e2e/auth.setup.ts:8: * The owner is also given a brand file: without one, `/[lang]/app` and `/[lang]/app/reports` redirect to the start
e2e/auth.setup.ts:15:  const state = await request.storageState();
e2e/auth.setup.ts:18:  const brand = await request.put("/api/brand", { data: SEEDED_BRAND });
e2e/error-states.spec.ts:1:import { test, expect, open } from "./fixtures/app";
e2e/error-states.spec.ts:14:    await open(page, "/en/app/generate");
e2e/error-states.spec.ts:19:    await page.route("**/api/generate", (route) =>
e2e/error-states.spec.ts:28:    await open(page, "/en/app/generate");
e2e/error-states.spec.ts:30:    await page.route("**/api/generate", (route) => route.abort("connectionfailed"));
e2e/error-states.spec.ts:40:    await open(page, "/en/app/tasks");
e2e/error-states.spec.ts:43:    await page.route("**/api/schedule", (route) =>
e2e/error-states.spec.ts:58:    await open(page, "/en/app/tasks");
e2e/error-states.spec.ts:59:    await page.route("**/api/schedule", (route) =>
e2e/app-routes.spec.ts:1:import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
e2e/app-routes.spec.ts:48:  for (const path of ["/en/app/conversations?q=one&q=two", "/en/app/reports?range=7&range=30", "/en/app/chat?conv=a&conv=b"]) {
e2e/reskin-layout.spec.ts:10:export const PAGES: string[] = ["", "/pricing", "/app/login", "/agents", "/agents/faris", "/for/ecommerce", "/compare", "/ai-marketing-agent", "/customers", "/enterprise", "/tools", "/tools/hook-genera
e2e/reskin-layout.spec.ts:15:export const APP_PAGES: string[] = ["/app/start", "/app/settings/brand", "/app", "/app/chat", "/app/conversations", "/app/todo", "/app/tasks", "/app/calendar", "/app/files", "/app/settings/brands", "/a
e2e/reskin-layout.spec.ts:51:          await page.goto(`/${lang}${path}`);
e2e/redirects.spec.ts:1:import { test, expect, open, LANGS } from "./fixtures/app";
e2e/redirects.spec.ts:36:        expect(new URL(page.url()).pathname, `${route.path} must not render for a signed-out visitor`).toBe(`/${lang}/app/login`);
e2e/redirects.spec.ts:44:    test(`/${lang}/app/verify sends a signed-out visitor to the login page`, async ({ page }) => {
e2e/redirects.spec.ts:45:      const res = await open(page, `/${lang}/app/verify`);
e2e/redirects.spec.ts:47:      expect(new URL(page.url()).pathname).toBe(`/${lang}/app/login`);
e2e/redirects.spec.ts:52:    for (const path of APP_PUBLIC_ROUTES.filter((p) => p !== "/app/admin")) {
e2e/redirects.spec.ts:69:        const res = await request.get(`/${lang}${path}`, { maxRedirects: 0 });
e2e/auth-flows.spec.ts:2:import { test, expect, open, formAlert, fillWhenReady } from "./fixtures/app";
e2e/auth-flows.spec.ts:9: * Signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), so exactly ONE test here creates an
e2e/auth-flows.spec.ts:26: * Plays the first-login game (src/components/app/DictionaryStart.tsx) from step 1 to step 7, where the site link and
e2e/auth-flows.spec.ts:55:    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/onboard")) onboardCalls.push(`${r.method()} ${path}`); });
e2e/auth-flows.spec.ts:61:    await page.waitForURL("**/en/app/signup?url=roastery.example");
e2e/auth-flows.spec.ts:69:    const signupReply = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/signup");
e2e/auth-flows.spec.ts:75:    await page.waitForURL(/\/en\/app\/verify\?next=/);
e2e/auth-flows.spec.ts:78:    await open(page, "/en/app/chat");
e2e/auth-flows.spec.ts:80:    await page.waitForURL((u) => u.pathname === "/en/app/verify" && u.searchParams.get("next") === "/en/app/chat");
e2e/auth-flows.spec.ts:85:    await page.waitForURL("**/en/app/start?url=roastery.example");
e2e/auth-flows.spec.ts:93:    const build = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/onboard");
e2e/auth-flows.spec.ts:98:    expect(onboardCalls.slice(0, 2)).toEqual(["POST /api/onboard/confirm", "POST /api/onboard"]);
e2e/auth-flows.spec.ts:100:    await page.waitForURL(/\/en\/app\/chat$/, { timeout: 30_000 });
e2e/auth-flows.spec.ts:104:    await open(page, "/en/app/signup");
e2e/auth-flows.spec.ts:109:    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
e2e/auth-flows.spec.ts:113:    await open(page, "/en/app/signup");
e2e/auth-flows.spec.ts:136:    await open(page, "/en/app/signup");
e2e/auth-flows.spec.ts:162:    await open(page, "/en/app/signup");
e2e/auth-flows.spec.ts:171:    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
e2e/auth-flows.spec.ts:177:   * Logging in is throttled per account (eight per fifteen minutes, `src/app/api/auth/login/route.ts`). The happy path
e2e/auth-flows.spec.ts:183:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:190:    await page.waitForURL("**/en/app/start");
e2e/auth-flows.spec.ts:195:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:201:    expect(new URL(page.url()).pathname).toBe("/en/app/login");
e2e/auth-flows.spec.ts:205:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:214:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:216:    page.on("request", (r) => { if (r.url().includes("/api/auth/login")) posted = true; });
e2e/auth-flows.spec.ts:225:    await authed.goto("/en/app/login", { waitUntil: "domcontentloaded" });
e2e/auth-flows.spec.ts:226:    expect(new URL(authed.url()).pathname).toBe("/en/app");
e2e/auth-flows.spec.ts:243:    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/onboard")) onboardCalls.push(`${r.method()} ${path}`); });
e2e/auth-flows.spec.ts:245:    await open(page, "/en/app/chat?onboard=attacker.example");
e2e/auth-flows.spec.ts:246:    await page.waitForURL("**/en/app/start?url=attacker.example");
e2e/auth-flows.spec.ts:253:    const res = await page.request.post("/api/onboard", { data: { url: "attacker.example" } });
e2e/auth-flows.spec.ts:268:    const state = await request.storageState();
e2e/auth-flows.spec.ts:272:    await authed.goto("/en/app/settings/danger", { waitUntil: "domcontentloaded" });
e2e/auth-flows.spec.ts:286:    await authed.waitForURL("**/app/login");
e2e/auth-flows.spec.ts:288:    await authed.goto("/en/app", { waitUntil: "domcontentloaded" });
e2e/auth-flows.spec.ts:289:    expect(new URL(authed.url()).pathname, "the session must be dead after logging out").toBe("/en/app/login");
e2e/auth-flows.spec.ts:297:      await open(page, "/en/app/forgot");
e2e/auth-flows.spec.ts:321:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:322:    await page.route("**/api/auth/login", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ ok: false, error: "slow_down" }) }));
e2e/auth-flows.spec.ts:331:    await open(page, "/en/app/login");
e2e/auth-flows.spec.ts:332:    await page.route("**/api/auth/login", (route) => route.abort("connectionfailed"));
e2e/auth-flows.spec.ts:341:    await open(page, "/en/app/signup");
e2e/auth-flows.spec.ts:342:    await page.route("**/api/auth/signup", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));
e2e/auth-flows.spec.ts:351:    expect(new URL(page.url()).pathname).toBe("/en/app/signup");
e2e/auth-flows.spec.ts:357:    await open(page, `/en/app/reset#t=${"b".repeat(64)}`);
e2e/auth-flows.spec.ts:371:    await open(page, `/en/app/reset#t=${"a".repeat(64)}`);
e2e/home.spec.ts:1:import { test, expect, open, LANGS } from "./fixtures/app";
e2e/home.spec.ts:53:      await expect(page.locator(`#price a[href="/${lang}/app/signup"]`)).toHaveCount(3);
e2e/home.spec.ts:66:      const form = await page.locator(`#team form[action="/${lang}/app/signup"]`).boundingBox();
e2e/home.spec.ts:79:      await expect(bar.getByRole("link")).toHaveAttribute("href", `/${lang}/app/signup`);
e2e/fixtures/app.ts:89:  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
e2e/fixtures/app.ts:97: * `page.goto(..., { waitUntil: "domcontentloaded" })` returns while the client bundle may still be evaluating. A
e2e/fixtures/routes.ts:1:import type { Lang } from "./app";
e2e/fixtures/routes.ts:48: * The authenticated route patterns under /[lang]/app. `heading` is the page's own first-level heading, taken from the
e2e/fixtures/routes.ts:52: * `ownerGoesTo`: the page sends the signed-in, seeded owner elsewhere instead of rendering. `/app/start` is the
e2e/fixtures/routes.ts:59:  { path: "/app", heading: { en: "Approval inbox" } },
e2e/fixtures/routes.ts:60:  { path: "/app/todo", heading: { en: "My to-dos" } },
e2e/fixtures/routes.ts:61:  { path: "/app/tasks", heading: { en: "Scheduled tasks" } },
e2e/fixtures/routes.ts:62:  { path: "/app/calendar", heading: { en: "Calendar" } },
e2e/fixtures/routes.ts:63:  { path: "/app/chat", heading: { en: "Noor" } },
e2e/fixtures/routes.ts:64:  { path: "/app/conversations", heading: { en: "Chat history" } },
e2e/fixtures/routes.ts:65:  { path: "/app/generate", heading: { en: "What do you need from Noor today?" } },
e2e/fixtures/routes.ts:66:  { path: "/app/reports", heading: { en: "Performance" } },
e2e/fixtures/routes.ts:67:  { path: "/app/files", heading: { en: "Files" } },
e2e/fixtures/routes.ts:69:  { path: "/app/settings", heading: { en: "Settings" } },
e2e/fixtures/routes.ts:70:  { path: "/app/settings/account", heading: { en: "Account" } },
e2e/fixtures/routes.ts:71:  { path: "/app/settings/security", heading: { en: "Security" } },
e2e/fixtures/routes.ts:72:  { path: "/app/settings/notifications", heading: { en: "Notifications" } },
e2e/fixtures/routes.ts:73:  { path: "/app/settings/brands", heading: { en: "Brands" } },
e2e/fixtures/routes.ts:74:  { path: "/app/settings/governance", heading: { en: "Governance" } },
e2e/fixtures/routes.ts:75:  { path: "/app/settings/danger", heading: { en: "Danger zone" } },
e2e/fixtures/routes.ts:76:  { path: "/app/activity", heading: { en: "Activity" } },
e2e/fixtures/routes.ts:77:  { path: "/app/settings/members", heading: { en: "Members" } },
e2e/fixtures/routes.ts:78:  { path: "/app/settings/connections", heading: { en: "Integrations" } },
e2e/fixtures/routes.ts:79:  { path: "/app/inspo", heading: { en: "Gulf inspiration" } },
e2e/fixtures/routes.ts:80:  { path: "/app/notifications", heading: { en: "Notifications" } },
e2e/fixtures/routes.ts:81:  { path: "/app/settings/brand", heading: { en: "Introduce Noor to your brand" } },
e2e/fixtures/routes.ts:82:  { path: "/app/refer", heading: { en: "Earn credits" } },
e2e/fixtures/routes.ts:83:  { path: "/app/partner", heading: { en: "Partner" } },
e2e/fixtures/routes.ts:84:  { path: "/app/mcp", heading: { en: "Noor inside Claude and ChatGPT (MCP)" } },
e2e/fixtures/routes.ts:85:  { path: "/app/help", heading: { en: "Help center" } },
e2e/fixtures/routes.ts:86:  { path: "/app/settings/billing", heading: { en: "Subscription" } },
e2e/fixtures/routes.ts:87:  { path: "/app/start", heading: { en: "The Thakeen Dictionary" }, ownerGoesTo: "/app" },
e2e/fixtures/routes.ts:91:/** `/app/join` accepts a team invite; its token travels in the URL fragment, so a plain visit shows "link incomplete". */
e2e/fixtures/routes.ts:92:export const APP_PUBLIC_ROUTES = ["/app/login", "/app/signup", "/app/forgot", "/app/reset", "/app/admin", "/app/join"];
e2e/public-pages.spec.ts:1:import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
e2e/public-pages.spec.ts:42:        const res = await page.request.get(url.pathname + url.search);
e2e/fixtures/accounts.ts:5: * instead of signing up again: signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), and a
e2e/fixtures/accounts.ts:48:    const send = await request.post("/api/auth/verify/send", { headers });
e2e/fixtures/accounts.ts:54:  const check = await request.post("/api/auth/verify/check", { data: { code }, headers });
e2e/fixtures/accounts.ts:60:  const signup = await request.post("/api/auth/signup", { data, headers: { "x-forwarded-for": simulatedIp(clientIp) } });
e2e/fixtures/accounts.ts:70: * (`src/app/api/auth/signup/route.ts`, five per hour) answered before the route ever looked the account up. The
e2e/fixtures/accounts.ts:86:  const login = await request.post("/api/auth/login", { data: { email: account.email, password: account.password } });

## Appendix F: server-made app links in src/lib and api
src/lib/secretary-remind.ts:94:      kind: "todo", agent: "reem", href: `/${user.lang}/app/todo`, about: aboutKey("todo", scope, item.id),
src/lib/secretary-tools.ts:138:  owner_only: "Only the owner can complete, skip, delete, restore or reopen items, stop or end a repeat, change an item's inbox link or a contact's number, on the My to-dos page (/app/todo). Use todo_propose_done to ask
src/lib/secretary-tools.ts:397:        return { text: `Proposed as done [id=${id}] ${JSON.stringify(r.item.title)}. It is NOT done yet: it waits under "needs your confirmation" until the owner confirms it on the My to-dos page (/app/todo), where your
src/lib/chat-prompt.ts:60:      ? `${agent.persona} You are talking with the owner of the business described under BRAND, inside Thakeen. You keep the owner's list with agenda_get, todo_create, todo_update and todo_propose_done, all free. When the ow
src/lib/chat-prompt.ts:77:- Keep the owner's to-do list (Reem's) with agenda_get, agenda_next, todo_create, todo_update and todo_propose_done: free. Repeat a saved date back exactly as the tool writes it, and say when a reminder arrives exactly as th
src/lib/chat-prompt.ts:84:Pages: /app/chat (you), /app (inbox), /app/todo (my to-dos), /app/files, /app/tasks (scheduled routines), /app/governance, /app/activity (what each agent did, with a CSV download), /app/integrations, /app/mcp, /app/billing, 
src/lib/notifications.ts:197:  const app = `/${user.lang}/app`;
src/lib/notifications.ts:335:        kind: "todo", agent: "reem", href: `/${lang}/app/todo`, about: aboutKey("todo", scope, it.id),
src/lib/notifications.ts:350:  return pushNotif(email, { ...n, href: n.href.startsWith("/") ? n.href : `/${lang}/app/${n.href}` }, fp, ttl, scope);
src/lib/pwa.ts:17:export const PWA_START = "/app";
src/lib/pwa.ts:40:export const APPLE_ICON_FILE = "src/app/apple-icon.png";
src/lib/notif-digest.ts:76:  return { subject, paragraphs, text: paragraphs.join("\n\n"), href: `${appOrigin()}/${lang}/app/notifications` };
src/lib/settings-nav.ts:28:export const settingsHref = (lang: Lang, section?: SettingsSection) => `/${lang}/app/settings${section ? `/${section}` : ""}`;
src/lib/settings-nav.ts:48:const LEGACY_PATH = new RegExp(`^/(ar|en)/app/(${Object.keys(LEGACY_SETTINGS).join("|")})/?$`);
src/lib/secretary-gcal.ts:220:      href: `/${owner.lang}/app/todo`,
src/lib/lifecycle.ts:33:  const app = `${appOrigin()}/${u.lang}/app`;
src/lib/lifecycle.ts:80:  const app = `${appOrigin()}/${u.lang}/app`;
src/lib/secretary-feed.ts:201:  const url = clean(`${o.origin}/${o.lang}/app/todo`);
src/lib/secretary-walk.ts:176:  const where = c.kind === "approval" ? "in the approval inbox (/app)" : "on the My to-dos page (/app/todo)";
src/lib/billing.ts:177:      redirectionUrl: `${appOrigin()}/${lang}/app/billing?paymob=return`,
src/lib/billing.ts:443:      redirectionUrl: `${appOrigin()}/${u.lang}/app/billing`,
src/lib/secretary-series.ts:122:    const href = `/${lang}/app/todo?series=${named[0].sid}`;
src/lib/media/jobs.ts:670:  await pushNotif(j.email, { kind: "info", ...n, href: `/${j.lang}/app` });
src/lib/chat-reply.ts:52:  const billing = `${o.origin ?? ""}/${lang}/app/billing`;
src/lib/secretary-evening.ts:209:    await notifyItem(acct(user), user.lang, { kind: "todo", agent: "reem", title, body, href: `/${user.lang}/app/todo` }, undefined, undefined, scope);
src/lib/secretary-evening.ts:217:    if (emailAllowed(await readPrefs(scope, user.email), "evening")) await sendEmail({ to: user.email, subject, text: `${title}\n\n${body}\n\n${appOrigin()}/${user.lang}/app/todo`, template: "notice", context: { title
src/app/api/auth/forgot/route.ts:50:    const link = `${appOrigin()}/${lang}/app/reset#t=${token}`;
src/app/api/auth/google/callback/route.ts:28:  const fail = (code: string, page: "login" | "signup" = "login") => go(`/${lang}/app/${page}?google=${code}`);
src/app/api/auth/google/callback/route.ts:31:  if (q.get("error")) return st.mode === "link" ? go(`/${lang}/app/settings/security?google=google_cancelled`) : fail("google_cancelled", st.mode === "signup" ? "signup" : "login");
src/app/api/auth/google/callback/route.ts:33:  if (!id) return st.mode === "link" ? go(`/${lang}/app/settings/security?google=google_failed`) : fail("google_failed", st.mode === "signup" ? "signup" : "login");
src/app/api/auth/google/callback/route.ts:40:    return go(`/${lang}/app/settings/security?google=${r === "ok" ? "linked" : r}`);
src/app/api/auth/google/callback/route.ts:64:    return go(st.next || `/${lang}/app/start`);
src/app/api/auth/google/callback/route.ts:71:  if (f.kind === "mfa") return go(`/${lang}/app/login?mfa=1${st.next ? `&next=${encodeURIComponent(st.next)}` : ""}`);
src/app/api/auth/google/callback/route.ts:72:  return go(st.next || `/${lang}/app`);
src/app/api/admin/users/[email]/route.ts:253:      return NextResponse.json({ ok: true, redirect: `/${u.lang === "en" ? "en" : "ar"}/app` });
src/app/api/mcp/route.ts:63:  return NextResponse.json({ name: "thakeen", version: "0.3.0", transport: "streamable-http", auth: ["oauth2.1 (PKCE, DCR) — see /.well-known/oauth-authorization-server", "personal bearer token from /app/mcp"], tools: TO
src/app/api/mcp/route.ts:78:  if (!user) return err(id, -32001, "Unauthorized: connect via OAuth (this server advertises /.well-known/oauth-authorization-server) or add Authorization: Bearer <personal token from /ar/app/mcp>", 401);
src/app/api/team/invite/route.ts:101:  const link = `${appOrigin()}/${inv.lang}/app/join#t=${res.token}`;
src/app/api/connect/[provider]/start/route.ts:37:    return NextResponse.redirect(`${appOrigin()}/${lang}/app/integrations?error=slow_down`, { headers: retryAfter(WINDOW.hour) });
src/app/api/connect/[provider]/start/route.ts:56:      return NextResponse.redirect(`${appOrigin()}/${lang}/app/integrations?error=${code}`);
src/app/api/connect/[provider]/callback/route.ts:47:  const back = (q: string) => NextResponse.redirect(`${origin}/${lang}/app/${cal ? "todo" : "integrations"}?${q}`);
src/app/api/cron/daily/route.ts:134:      const link = `${appOrigin()}/${u.lang}/app/start`;
src/app/api/cron/daily/route.ts:167:    const app = `${appOrigin()}/${u.lang}/app`;
src/app/api/cron/daily/route.ts:175:    if (await sendEmail({ to: u.email, subject, text, template: "notice", context: { title: subject, paragraphs: paragraphs(text), cta: { href: `${appOrigin()}/${u.lang}/app` } }, locale: u.lang })) out.push("email
src/proxy.ts:105:  } else if (pathname === "/" || pathname === "/app") {
src/proxy.ts:109:    url.pathname = pathname === "/" ? `/${pickLang(req)}` : `/${pickLang(req)}/app`;
src/app/robots.ts:9:  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }], sitemap: `${BASE}/sitemap.xml` };
src/app/p/[code]/route.ts:32:  const dest = new URL(`/${langOf(req)}/app/signup`, appOrigin());
src/app/oauth/authorize/page.tsx:56:  if (!u) redirect(`/${lang}/app/login?next=${encodeURIComponent(self)}`);
