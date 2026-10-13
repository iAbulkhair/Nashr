# Admin Shell (part A) Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built and merged as #304 (in `production`). The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the founder console out of the customer app into `/{lang}/admin` with its own layout and sidebar, one page per section.

**Architecture:** New route tree `src/app/[lang]/admin/` (sibling of `app/`), so the customer layout never wraps it. A server layout gates with `isAdminCookie()` and renders a client `AdminNav`. First every page renders the existing `AdminConsole` with a `section` prop (shell works end to end); then the console is split into one component per section and deleted. `/api/admin/*` is not touched.

**Tech Stack:** Next.js 16.3 app router (read `node_modules/next/dist/docs/` for layouts, `notFound`, `redirect` before coding), React 19, Tailwind 4, vitest 5 (`renderToStaticMarkup`, `tests/helpers/session.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md` part A.

## Global Constraints

- Branch: new branch `claude/admin-shell` from `main` (not the spec branch). PR to `main`, draft until the founder says merge. Never release to `production`.
- Rules 870-874 (this plan); 875-879 spare for part A follow-ups. Add rows to `docs/system/tests.md` in the task that pins them.
- Not a founder → plain 404, the console never advertises itself (spec A2).
- Key session: `/{lang}/admin?login=1` renders `AdminLogin` without the shell; renewal on every page load stays as `adminKeySession()` does it today.
- No agent, chat, credit, brand, trial, install-hint or limit-modal element in the admin shell.
- Copy: Arabic first, English second, same keys. Labels: «لوحة المؤسس» / "Founder console" (header), «لوحة الأدمن» / "Admin console" (account-menu link), «العودة للتطبيق» / "Back to the app".
- Colours only from tokens (rule 513), no hex in `src/`.
- `npm run check` and `npx next build` before every commit (CLAUDE.md). Local `next build` may be blocked; then say so in the PR and rely on CI.
- Update `docs/system/architecture.md`, `flows.md` and `permissions.md` in the same commit as the route change (CLAUDE.md).

## Review Focus

- A founder signed in normally AND holding a key session: the shell shows «العودة للتطبيق» and the "end key session" button, both work.
- Key session only (no normal login): no «العودة للتطبيق» link (it would land on login).
- The session ends mid-use (key session idle 15 min): every section shows the existing ended notice with the right link (`adminEndedHref`), not an empty table.
- `/en/app/admin?login=1` from an old bookmark lands on `/en/admin?login=1` with the query kept.
- Mobile width (375 px): the admin sidebar collapses to a menu button, no horizontal scroll.

---

### Task 1: Admin route tree, gate and shell

**Files:**
- Create: `src/app/[lang]/admin/layout.tsx`, `src/app/[lang]/admin/page.tsx`, `src/app/[lang]/admin/{users,leads,usage,billing,partners,quality,wishlist,log}/page.tsx`
- Create: `src/lib/admin-gate.ts`, `src/components/admin/AdminNav.tsx`
- Modify: `src/app/[lang]/app/admin/page.tsx` (becomes a redirect), `src/components/app/AdminConsole.tsx` (accepts `section`, loses its tab bar), `src/lib/admin-fetch.ts:33`, `src/app/api/admin/impersonate/route.ts:34`, `src/app/[lang]/app/layout.tsx` (`PUBLIC` drops `/admin`), `src/components/app/Sidebar.tsx` (root gets `data-testid="app-sidebar"`), `e2e/fixtures/routes.ts:87`
- Test: `tests/admin-shell.test.ts` (new), `tests/launch-security.test.ts:328`

**Interfaces:**
- Produces:
  - `ADMIN_SECTIONS = ["overview","users","leads","usage","billing","partners","quality","wishlist","log"] as const` and `type AdminSection`, plus `adminHref(lang: "ar"|"en", s: AdminSection): string` (`/{lang}/admin` for overview, `/{lang}/admin/{s}` otherwise) and `ADMIN_LEADS_SEEN = "admin:leads-seen"`, in `src/lib/admin-gate.ts` (client-safe: no runtime imports).
  - `requireAdmin(): Promise<{ keySession: boolean; founder: boolean }>` in `src/lib/admin-gate-server.ts`: `notFound()` unless `isAdminCookie()`; `keySession` = `adminKeySession()`; `founder` = `isFounderActor(await currentUser())`.
  - `AdminNav({ lang, keySession, founder }: { lang: "ar"|"en"; keySession: boolean; founder: boolean })`, client: section links (active by `usePathname`), leads unread badge (`GET /api/admin/leads?limit=0` through `adminFetch`, cleared on the `ADMIN_LEADS_SEEN` window event), «العودة للتطبيق» only when `founder`, "end key session" only when `keySession` (moved out of `AdminConsole`), menu button under `lg`.
  - Temporary until Task 3: `AdminConsole({ lang, keySession, section }: { lang: "ar"|"en"; keySession: boolean; section: AdminSection })`.

- [ ] **Step 1: Write the failing tests** in `tests/admin-shell.test.ts` (helpers `P = (l) => Promise.resolve({ lang: l })`, `Q = (o) => Promise.resolve(o)`, `pageFor(s)` imports `@/app/[lang]/admin/{s}/page` or the root page for overview):

```ts
describe("the founder console has its own shell (rules 870-872)", () => {
  it("every /{lang}/admin page is a 404 without the gate", async () => {
    for (const s of ADMIN_SECTIONS) await expect((await pageFor(s))({ params: P("en"), searchParams: Q({}) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
  it("with a key session the layout renders AdminNav and never the customer Sidebar", async () => {
    await adminSignIn();
    const html = renderToStaticMarkup(await AdminLayout({ children: null, params: P("ar") }));
    expect(html).toContain("لوحة المؤسس");
    expect(html).not.toContain('data-testid="app-sidebar"');
    expect(html).not.toContain("العودة للتطبيق"); // key session only, no founder login
  });
  it("?login=1 without the gate renders the key form and no shell", async () => {
    const html = renderToStaticMarkup(await AdminHome({ params: P("en"), searchParams: Q({ login: "1" }) }));
    expect(html).toMatch(/type="password"/);
    expect(html).not.toContain("Founder console");
  });
  it("/{lang}/app/admin redirects to /{lang}/admin with the query kept", async () => {
    await expect(OldAdmin({ params: P("en"), searchParams: Q({ login: "1" }) })).rejects.toMatchObject({ digest: expect.stringContaining("/en/admin?login=1") });
  });
  it("adminHref", () => {
    expect(adminHref("ar", "overview")).toBe("/ar/admin");
    expect(adminHref("en", "log")).toBe("/en/admin/log");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/admin-shell.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Implement.**
  - Layout: do NOT call `requireAdmin()` there (it would 404 the `?login=1` form). Render the shell (header + `AdminNav` + `<main>`) only when `isAdminCookie()`, bare `children` otherwise.
  - Every section page calls `requireAdmin()` first. The overview page renders `<AdminLogin lang>` when the gate fails and `login === "1"`, else `notFound()` (today's `app/admin/page.tsx` behaviour).
  - Old page: redirect to `/${lang}/admin` plus the original query string (use `permanentRedirect` if the Next 16 docs confirm 308; the test checks the target).
  - `adminEndedHref` (`src/lib/admin-fetch.ts:33`): the key-session target becomes `/${lang}/admin?login=1`; the founder target stays `/${lang}/app/login`. Impersonation return → `/${lang}/admin/users`.
  - `AdminConsole`: delete the tab bar, `tab` state and the key-session button; render the body for `section`.

- [ ] **Step 4: Update** `tests/launch-security.test.ts:328` to `/${lang}/admin?login=1` and `e2e/fixtures/routes.ts` (`/app/admin` out of `APP_PUBLIC_ROUTES`). Run `npx vitest run tests/admin-shell.test.ts tests/launch-security.test.ts` — Expected: PASS.

- [ ] **Step 5: Docs** — `docs/system/tests.md` rows 870 (gate: 404 on every section, key form only at `?login=1`), 871 (own shell, no customer chrome), 872 (old path redirects with query, ended and impersonation links point to `/admin`); `permissions.md` route rows for `/{lang}/admin/*`; `architecture.md` and `flows.md` wherever they name `/app/admin`.

- [ ] **Step 6: Commit** — `npm run check` green, then `git commit -m "feat(admin): own route and shell at /{lang}/admin (870-872)"`.

### Task 2: Founder link leaves the customer main nav

**Files:**
- Modify: `src/components/app/Sidebar.tsx:148` (delete the main-nav row), `:169` (href `adminHref(lang, "overview")`, label `N.adminPanel`), `src/lib/app-i18n.ts` (`adminPanel`: «لوحة الأدمن» / "Admin console"; remove `founder` if nothing else uses it)
- Test: `tests/admin-shell.test.ts`

**Interfaces:**
- Consumes: `adminHref` (Task 1).

- [ ] **Step 1: Failing test** (rule 873):

```ts
it("no founder row in the customer main nav; the account menu links to /{lang}/admin (rule 873)", () => {
  const html = (admin: boolean) => renderToStaticMarkup(createElement(Sidebar, { t: appDict.ar, lang: "ar", user, show, admin }));
  expect(html(true)).not.toContain('href="/ar/app/admin"');
  expect(html(false)).not.toContain("/ar/admin");
  expect(readFileSync("src/components/app/Sidebar.tsx", "utf8")).toMatch(/admin \? \[\[adminHref\(lang, "overview"\), N\.adminPanel\]\]/);
});
```

(The account menu renders only when opened, so the source assertion pins its link; the markup assertions pin the main nav.)

- [ ] **Step 2: Run** — Expected: FAIL on `href="/ar/app/admin"`.
- [ ] **Step 3: Implement** the two Sidebar edits and the dictionary key.
- [ ] **Step 4: Run** `npx vitest run tests/admin-shell.test.ts tests/teams-ui.test.ts tests/logout-visible.test.ts` — Expected: PASS.
- [ ] **Step 5: Docs + commit** — tests.md row 873; `git commit -m "feat(admin): founder link only in the account menu (873)"`.

### Task 3: One component per section; delete AdminConsole

**Files:**
- Create in `src/components/admin/`: `shared.tsx`, `Overview.tsx`, `Users.tsx`, `Usage.tsx`, `Billing.tsx`, `Quality.tsx`, `Log.tsx`
- Modify: the nine pages from Task 1 (each renders its component; leads/partners/wishlist render the existing `LeadsPanel` / `PartnersPanel` / `WishlistPanel`; quality renders `Quality` then `GoldenPanel`), `src/components/app/LeadsPanel.tsx` (`onSeen` replaced by dispatching `ADMIN_LEADS_SEEN`)
- Delete: `src/components/app/AdminConsole.tsx`
- Test: `tests/admin-shell.test.ts`, `tests/launch-security.test.ts:337-345`, `tests/reskin-app.test.ts:59-61`, and whatever `grep -rl AdminConsole tests e2e` returns

**Interfaces:**
- Consumes: `AdminSection`, `ADMIN_LEADS_SEEN` (Task 1).
- Produces:
  - `shared.tsx`: `STR` and `OV` (moved, same keys), `useAdminEnded(): boolean` (subscribes to `ADMIN_ENDED_EVENT`), `EndedNotice({ lang, keySession })`, and the types moved from AdminConsole (`U`, `Detail`, `MemberDetail`, `Overview`, `MediaCheck`, `TeamChange`, `KindUsage`).
  - Each section: `({ lang, keySession }: { lang: "ar"|"en"; keySession: boolean }) => JSX`, fetching only its own data. Overview: `/api/admin/overview`, `/api/admin/plan` (the tiles), media check. Users: `/api/admin/plan`, `/api/admin/users/{email}` and every handler now in the console (`act`, `setPlan`, `setSeats`, chat, video, top-up, payment) moved unchanged. Usage and Billing: `/api/admin/overview`. Quality: `/api/admin/evals`. Log: `/api/admin/log`.

- [ ] **Step 1: Failing test** (rule 874):

```ts
it("each section fetches only its own endpoints and AdminConsole is gone (rule 874)", () => {
  expect(existsSync("src/components/app/AdminConsole.tsx")).toBe(false);
  const src = (f: string) => readFileSync(`src/components/admin/${f}.tsx`, "utf8");
  expect(src("Log")).toMatch(/\/api\/admin\/log/);
  expect(src("Log")).not.toMatch(/\/api\/admin\/(plan|overview|evals)/);
  expect(src("Quality")).not.toMatch(/\/api\/admin\/plan/);
  for (const f of ["Overview", "Users", "Usage", "Billing", "Quality", "Log"]) expect(src(f)).toMatch(/useAdminEnded\(\)/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Move code** section by section (bodies at `AdminConsole.tsx` 506-823, handlers at 182-460), no behaviour change, then delete the file. Repoint the `launch-security` and `reskin-app` file lists to the new files with the same assertions (e.g. "every admin call goes through `adminFetch`" loops over `src/components/admin/*.tsx`).
- [ ] **Step 4: Run** `npm run check` — Expected: all green.
- [ ] **Step 5: Docs + commit** — tests.md row 874; `git commit -m "refactor(admin): one component per console section (874)"`.

### Task 4: Verify and open the PR

- [ ] **Step 1:** `npx next build` — Expected: success, `/[lang]/admin/*` listed. If blocked locally, record why in the PR.
- [ ] **Step 2:** Preview (dev server from `.claude/launch.json`): open a key session at `/ar/admin?login=1` with the key from the local `.env` (never typed into chat), visit all nine sections in Arabic and English at desktop and 375 px, screenshot overview and users. Signed out: `/ar/admin/users` → 404, `/ar/app/admin` → `/ar/admin`.
- [ ] **Step 3:** Push `claude/admin-shell`, open a draft PR naming rules 870-874, the spec path and "release step: none (no stored shape change)". Bind it with the ccd_pr tools. Merge only on the founder's word.
