# Admin shell, brand limits per plan, brand in the URL — design

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** Part A (the admin shell) merged as #304 (2026-10-10, in `production`). Part B (brand limits per plan) was built after that date: merged to `main` as #340 (rules 1390-1395, `docs/system/tests/1390-brand-limits.md`), part of the #347 batch, not in `production` yet (checked 2026-10-13). Part C (the brand id in the URL) is not built; "Spec only, no code" below is true of C only.

Status: design approved in conversation on 2026-10-09 (founder: «صحيحة»). Spec only, no code. Branch `claude/admin-panel-brand-management-7d1abe`. Rules 870-899 reserved for this work (870-879 part A, 880-884 part B, 885-899 part C); check `docs/system/tests.md` after other merges.

Three pull requests, in this order, each on its own branch, none merged or released without the founder's word:

1. **A. Admin shell** — the founder console leaves the customer app.
2. **B. Brand limits per plan** — replaces rule 245 ("brands are unlimited").
3. **C. Brand in the URL** — every brand page carries its brand; a switcher; an all-brands page. May ship as C1 (routing, header, guard) and C2 (switcher, all-brands page).

## 0. What exists today (2026-10-09, main `8dab9ea`)

- The console is one page, `src/app/[lang]/app/admin/page.tsx`, rendering `src/components/app/AdminConsole.tsx` (823 lines, 9 tabs: overview, users, leads, usage, billing, partners, quality, wishlist, log). It sits inside `src/app/[lang]/app/layout.tsx`, so the founder sees the customer sidebar (agents, chats, credits, trial banner) around it, and «المؤسس» is a main-nav row in `src/components/app/Sidebar.tsx:148`.
- Brands: `src/lib/brands.ts`. Unlimited on every plan (rule 245), bounded by a creation rate. Each brand has its own storage scope (`email` for `default`, `email#brandId` otherwise). The active brand is stored per login (`activebrand:{login}`) and read in `resolveSession` (`src/lib/auth.ts`), so `sc(u)` follows it.
- Switching happens only on `/app/brands` (`BrandsPanel.tsx`).
- **Defect this design removes:** because the active brand lives on the server, a second tab that switches brand silently moves the first tab: it still shows brand X, but its next save lands in brand Y. No data crosses accounts, but it mixes one customer's brands, which is worst for agencies.
- Team members see and may switch to every brand of the account. Per-brand member access does not exist (out of scope here; part C leaves the hook for it).
- supastarter (`~/projects/supastarter`, licence bought by the founder) has organizations with the slug in the URL (`/[organizationSlug]/…`), an `OrganizationSelect` dropdown at the top of the sidebar and an `OrganizationsGrid` start page. Its admin (`/admin/users`, `/admin/organizations`) is a settings menu inside the same app shell, not a separate environment. We copy patterns (switcher, list with search and pagination, grid), not packages: it runs on Prisma and better-auth, Thakeen on Redis.

## A. Admin shell (rules 870-879)

### A1. Routes

| Path | What |
|---|---|
| `/{lang}/admin` | Overview |
| `/{lang}/admin/users` | Users (list, search, account actions, impersonation, **brand cap** from part B) |
| `/{lang}/admin/leads` | Leads |
| `/{lang}/admin/usage` | Usage |
| `/{lang}/admin/billing` | Billing |
| `/{lang}/admin/partners` | Partners |
| `/{lang}/admin/quality` | Quality (golden, evals) |
| `/{lang}/admin/wishlist` | Wishlist |
| `/{lang}/admin/log` | Audit log |
| `/{lang}/admin?login=1` | Key-session login form (`AdminLogin`), unchanged behaviour |
| `/{lang}/app/admin` | 308 to `/{lang}/admin` (query kept) |

`src/app/[lang]/admin/` is a sibling of `src/app/[lang]/app/`, so the customer layout (session redirect, sidebar, trial banner, install hint, limit modal) never wraps it.

### A2. Shell

- `src/app/[lang]/admin/layout.tsx`: own header (wordmark + «لوحة المؤسس», language toggle, session note with "end key session" when it is a key session) and own sidebar listing the nine pages, plus «العودة للتطبيق» to `/{lang}/app` when the founder also has a normal session. No agent, chat, credit, brand or trial element.
- Gate unchanged: `isAdminCookie()`. Not a founder → plain 404 (the console never advertises itself). The layout renders the shell only when the gate passes; every page also calls one `requireAdmin()` helper that 404s, so a page can never render without it. `?login=1` on the overview renders `AdminLogin` with no shell.
- The 15-minute idle / 12-hour key session (`createAdminSession`) is renewed on each page load, as today.

### A3. Splitting `AdminConsole.tsx`

- One component per page under `src/components/admin/` (`Overview.tsx`, `Users.tsx`, …), moved from the tab bodies with their state. Shared bits (`adminFetch`, reason prompt, ended-session notice) go to `src/components/admin/shared.tsx`.
- `/api/admin/*` is not touched. `adminEndedHref` (`src/lib/admin-fetch.ts`) and the impersonation return (`src/app/api/admin/impersonate/route.ts:34`) point to `/{lang}/admin`.
- The leads unread badge moves to the sidebar row.

### A4. Navigation between the two environments

- The «المؤسس» row leaves the main nav of `Sidebar.tsx`. «لوحة الأدمن» appears only in the account menu (bottom of the sidebar), only for `isFounderActor(user)`.
- Signing in still lands in the app.
- The impersonation banner in the app keeps its "Stop and return to console" button, now returning to `/{lang}/admin/users`.

### A5. Tests (A)

- Every `/{lang}/admin/*` page answers 404 without the gate and renders the admin shell with it; none renders `Sidebar`.
- `/{lang}/app/admin` redirects to `/{lang}/admin`.
- The customer sidebar has no founder row in its main nav; the account menu shows it only to a founder.
- Existing console tests (rule 436 and others naming `/app/admin`) are updated to the new paths, not deleted.

## B. Brand limits per plan (rules 880-884)

### B1. Limits

In `src/lib/pricing.ts` (the only file allowed to hold allowances):

| Plan | Active brands |
|---|---|
| `trial` | 1 |
| `starter` | 1 |
| `pro` | 2 |
| `business` | 5 |
| `agency` | 10 by default; the founder sets the number per account |

- `brandCapFor(u)` = `u.brandCap` when set, else the plan's number.
- New optional field `User.brandCap?: number` (integer 1-200). Written only by the founder from `/{lang}/admin/users` through a new `POST /api/admin/brand-cap` (`isAdmin(req)`, reason required, audit log row with before/after like the other founder actions). Older code ignores the field, so this is a one-release expand with no contract step.
- Counted: brands with `status: "active"`, the default brand included. Archived brands do not count.

### B2. Enforcement

- `POST /api/brands` `add`, and `archive` used as restore, check the count **inside** `withBrandsLock`, so two adds side by side cannot both pass. Over the cap: `402 { error: "brand_limit", cap, plan }`, nothing written. The creation rate (`brandAddRefusal`) stays and is checked first.
- A downgrade never archives or deletes: an account above its new cap keeps every brand working and cannot add or restore until it is under the cap.
- No migration: every current account is a test account (founder, 2026-10-09).
- The brands UI shows "N of cap" and, at the cap, the add button opens the upgrade message (owner) or "ask the owner" (member).
- Copy: the pricing page and plan table state the brand count per plan; any copy saying brands are unlimited goes (`BrandsPanel.tsx` and `pricing.ts` comments today). The added brand's onboarding cost (rule 246) and the Sunday plan default (rule 247) are unchanged.

### B3. Rule 245

Rule 245 in `docs/system/tests.md` is marked replaced by 880 (not deleted), and `tests/brand-guardrails.test.ts` changes from "never 402" to the caps above, keeping its lock and rate cases.

## C. Brand in the URL (rules 885-899)

### C1. Routes

Brand pages move under `/{lang}/app/b/{brandId}/…`:

inbox (`/b/{id}`), chat, conversations, tasks, calendar, files, generate, governance, reports, activity, todo, inspo, integrations, onboarding (brand file), start.

Account pages stay at `/{lang}/app/…`: billing, profile, team, refer, partner, notifications, mcp, help, brands, and auth pages (login, signup, verify, join, forgot, reset).

The final page list is confirmed in the plan by reading each page and the APIs it calls: a page belongs under `b/` when anything it shows or saves goes through `sc(u)`.

- `/{lang}/app` with one active brand → 307 to `/{lang}/app/b/{that id}`. With two or more → the all-brands page (C5).
- Old brand URLs (`/{lang}/app/chat?…` etc.) → 307 to `/{lang}/app/b/{last}/chat?…`, with `last` = `activebrand:{login}`. Done once in the app layout, which already reads `x-pathname`. Old e-mail and notification links keep working.
- `src/app/[lang]/app/b/[brand]/layout.tsx` checks the brand is an active brand of the session's account and 404s otherwise.

### C2. Resolving the brand (one place)

- The brand id is taken from the request only as a **selector among the session account's own brands**. The email always comes from the session. `resolveSession` reads `x-nashr-brand`, checks it is in `listBrands(account)` with `status: "active"` (and, later, that the member may open it), then sets `u.brandId` and `u.scope = scopeFor(u.email, id)`. An unknown or archived id: pages 404, APIs `404 brand_not_found`. The 53 routes that use `sc(u)` do not change.
- Pages: `src/proxy.ts` sets `x-nashr-brand` from the `b/{id}` path segment and strips any incoming value on paths without it.
- APIs: the browser sends `x-nashr-brand` through one client helper, `api()` in `src/lib/api-client.ts`, which reads the id from the current path. Every `fetch("/api…")` in `src/components` (89 today) goes through it. A test fails on a raw `/api` fetch outside the helper.
- **Guard against a forgotten call:** a state-changing request (not GET or HEAD) made with a browser session to a brand-scoped API without the header answers `409 brand_missing` and writes nothing. It is enforced in one place, and a test fails when a route that calls `sc(u)` is not covered. Account-level APIs (billing, team, profile, brands, auth, notifications, admin) are exempt.
- No header on a GET (old client, MCP, cron) → `activebrand:{login}`, as today.
- MCP tokens, crons and OAuth callbacks keep their current brand resolution (`src/lib/mcp.ts` reads `activebrand`).

### C3. `activebrand:{login}`

It becomes "the brand last chosen" and is written only when the user picks a brand in the switcher, adds a brand, or opens the all-brands page and picks one, which is the same as today's explicit switch. Visiting a `/b/{id}` URL does **not** write it, so opening a link does not move the MCP token's brand or another device's default. No change to the stored shape.

### C4. Switcher

- At the top of the sidebar, replacing the brand link: current brand name and initial, then a dropdown with the active brands the login may open, «أضف براند» (owner/admin, under the cap) and «إدارة البراندات».
- Picking a brand keeps the sub-path (`/b/x/tasks` → `/b/y/tasks`; deep ids such as a conversation fall back to the section root) and writes `activebrand` (C3).
- Pattern from supastarter `OrganizationSelect`, rebuilt in Thakeen's components and tokens (no new UI package).

### C5. All-brands page

- `/{lang}/app/brands` becomes the overview plus management: one card per brand with name, pending approvals, last activity, credits used this month in that scope, and "open". Owner/admin also get add / rename / archive (as `BrandsPanel` today) and "N of cap" (part B).
- Reads are batched (`Promise.all` / `pmap`), never `await db.*` in a loop.
- Members see only brands they may open (all of them today).

### C6. Links made by the server

New notification, e-mail and chat-prompt links to a brand page include `/b/{id}` of the scope they belong to. The page list in the chat system prompt (`src/lib/chat.ts:255`) gets the brand path. Old stored links rely on the C1 redirect.

### C7. Rules text

`CLAUDE.md` "Never build a Redis key from an id, email or scope taken from the request" gains: "except the brand id, used only as a selector among the session account's own active brands after `resolveSession` has checked it". `docs/system/permissions.md` and `architecture.md` describe C2.

### C8. Tests (C)

- A brand page with another account's brand id, an unknown id or an archived id → 404. An API with such a header → 404, nothing read.
- Two tabs: tab 1 on brand X, tab 2 switches to Y. A save from tab 1 lands in X (the defect above).
- A state-changing brand-scoped call without the header → 409, nothing written. Coverage test over every route calling `sc(u)`.
- No raw `fetch("/api` in `src/components`.
- Old URLs redirect to the last-chosen brand with the query kept. `/app` with one brand goes to it; with two goes to all-brands.
- Visiting `/b/{id}` does not change `activebrand`; the switcher does.
- The proxy strips a forged `x-nashr-brand` on non-brand paths.

## D. Out of scope

- A separate admin domain or app (`admin.thakeen.com`). Option kept for later; part A leaves nothing that blocks it.
- Per-member brand access (Hootsuite-style). C2 has the single check point for it.
- Per-brand billing or credits. Credits stay shared by the account.
- Brand slugs in URLs (ids are stable across renames).

## E. Docs touched per part

`docs/system/architecture.md`, `flows.md`, `permissions.md` (route rows for `/admin/*`, `/api/admin/brand-cap`, brand-scoped routes), `tests.md` (rules 870-899, 245 marked replaced), `variables.md` (no new variable expected), `CLAUDE.md` (C7).
