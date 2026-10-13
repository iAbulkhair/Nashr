# Brand Limits per Plan (part B) Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built after 2026-10-12: merged to `main` as #340 (rules 1390-1395, `docs/system/tests/1390-brand-limits.md`) inside the #347 batch, not in `production` yet (checked 2026-10-13). The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap active brands per plan (trial 1, starter 1, pro 2, business 5, agency founder-set, default 10), replacing rule 245 "brands are unlimited".

**Architecture:** The numbers live in `src/lib/pricing.ts` next to `PLAN_SEATS`, with a `brandLimit(u)` helper shaped like `seatLimit`. The founder override is an optional `User.brandCap`, set through the existing `POST /api/admin/plan` exactly like the seat override. `POST /api/brands` checks the cap inside `withBrandsLock` for add and restore. Copy that promises unlimited brands is replaced by the per-plan count.

**Tech Stack:** Next.js 16.3, Upstash Redis via `src/lib/db.ts`, vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md` part B.

## Global Constraints

- Starts after part A is merged (the cap control lives in `src/components/admin/Users.tsx`). Branch `claude/brand-limits` from `main`. Draft PR; merge only on the founder's word; never release to `production` without his word.
- Rules 880-883; 884 spare. Rule 245 row in `docs/system/tests.md` is marked "replaced by 880-882 on 2026-10-09", not deleted.
- **Deviation from the spec, on purpose:** the spec named a new `POST /api/admin/brand-cap`. The plan sets the cap through `POST /api/admin/plan` with a `brands` field, the same path, lock, validation style, reason and audit-log row as `seats`. One founder route for plan-shaped overrides; say so in the PR. The spec's `brandCapFor` is named `brandLimit` here, beside `seatLimit`.
- **Order differs from the spec on purpose:** the spec says the creation rate is checked first, but `brandAddRefusal` (`src/lib/rate.ts`) spends a slot on every call, so an owner clicking add at the cap would burn the hour and then see 429 instead of the limit. A cheap count check runs before the rate (402, nothing spent); the authoritative check stays inside the lock. Say so in the PR.
- Counted brands: `status: "active"`, the default brand included. Archived brands never count.
- Over the cap → `402 { ok: false, error: "brand_limit", cap, plan }`, nothing written. Never archive or delete because of a cap (a downgrade keeps every brand working; adding and restoring stop until under the cap).
- No data migration: every account today is a test account (founder, 2026-10-09). `brandCap` is a new optional field that older code ignores: one release, no contract step.
- Site and app copy say «علامة» (the site's word), Arabic first. No "unlimited brands" claim anywhere outside `src/lib/changelog.ts` history entries.
- `pricing.ts` imports nothing (its header rule); keep it that way.
- `npm run check` and `npx next build` before every commit; docs in the same commit as the behaviour.

## Review Focus

- Two adds sent side by side by an owner on Pro with 1 brand: exactly one succeeds, the other gets 402 (cap checked inside the lock, not only before it).
- A refused add because of the cap does not use up the hour/day creation rate (cheap pre-check before `brandAddRefusal`, authoritative check inside the lock).
- Restoring an archived brand at the cap: 402, the brand stays archived.
- Founder lowers a cap (or the plan drops) below the active brand count: nothing archived, the brands page shows `3 / 1` and the add button is off.
- A member (not owner/admin) at the cap sees "ask the owner", not the upgrade link.

---

### Task 1: The numbers and the founder override

**Files:**
- Modify: `src/lib/pricing.ts` (after `MAX_SEAT_OVERRIDE`), `src/lib/auth.ts` (`User.brandCap?: number` beside `seats`), `src/app/api/admin/plan/route.ts` (`brands` field; GET rows gain `brands`, `brandsOverride`), `src/components/admin/Users.tsx` (a "Brands" value and button like seats), `src/lib/i18n.ts` (`brandsText`)
- Test: `tests/brand-limits.test.ts` (new)

**Interfaces:**
- Produces (all in `src/lib/pricing.ts`):
  - `PLAN_BRANDS: Readonly<Record<FixedPlan, number>> = { trial: 1, starter: 1, pro: 2, business: 5 }`
  - `AGENCY_BRANDS = 10`
  - `MAX_BRAND_OVERRIDE = 200`
  - `brandLimit(u: { plan: Plan; brandCap?: number }): number` — the override when it is an integer ≥ 1, else Agency → `AGENCY_BRANDS`, fixed plan → `PLAN_BRANDS[plan]`, anything else → 1.
- Produces in `src/lib/i18n.ts`: `brandsText(lang: Lang, n: number): string` — ar: 1 «علامة واحدة», 2 «علامتان», 3-10 «{n} علامات», 11+ «{n} علامة»; en: «1 brand», «{n} brands».
- `POST /api/admin/plan` body gains `brands?: number | null` (null or 0 clears; otherwise integer 1..`MAX_BRAND_OVERRIDE`, else 400 `bad_brands`), written under the same `withUserLock`, in the same audit row (`before`/`after` gain `brands: brandLimit(...)`, `what` gains `brands:{n|plan}`). Unlike seats, leaving Agency does NOT clear `brandCap` (no team to re-enforce; the founder clears it by hand).

- [ ] **Step 1: Failing tests** (rules 880, 881):

```ts
describe("brand limits per plan (rules 880-881)", () => {
  it("the table", () => {
    expect(["trial", "starter", "pro", "business", "agency"].map((plan) => brandLimit({ plan: plan as Plan }))).toEqual([1, 1, 2, 5, 10]);
    expect(brandLimit({ plan: "pro", brandCap: 7 })).toBe(7);
    expect(brandLimit({ plan: "pro", brandCap: 0 })).toBe(2);
  });
  it("brandsText", () => {
    expect((["ar", "en"] as Lang[]).flatMap((l) => [1, 2, 5, 12].map((n) => brandsText(l, n)))).toEqual(["علامة واحدة", "علامتان", "5 علامات", "12 علامة", "1 brand", "2 brands", "5 brands", "12 brands"]);
  });
  it("the founder sets and clears the cap through POST /api/admin/plan, logged with a reason", async () => {
    const u = await newUser({ plan: "agency" }); await adminSignIn();
    expect((await planPost({ email: u.email, brands: 25, reason: "deal" })).status).toBe(200);
    expect((await getUser(u.email))!.brandCap).toBe(25);
    expect(JSON.parse((await db.lrange("admin:log", 0, 0))[0])).toMatchObject({ what: expect.stringContaining("brands:25"), before: { brands: 10 }, after: { brands: 25 } });
    expect((await planPost({ email: u.email, brands: 201 })).status).toBe(400);
    await planPost({ email: u.email, brands: null, reason: "end" });
    expect((await getUser(u.email))!.brandCap).toBeUndefined();
  });
});
```

(`planPost` = the admin plan route's `POST` with a JSON request; reuse the helpers `tests/admin-deal.test.ts` uses for sign-in, users and requests.)

- [ ] **Step 2: Run** `npx vitest run tests/brand-limits.test.ts` — Expected: FAIL (`brandLimit` not exported).
- [ ] **Step 3: Implement** the interfaces above; the Users section shows `brands` from the GET row (with "(override)" when `brandsOverride`) and a button that prompts for a number and a reason, mirroring the seats button.
- [ ] **Step 4: Run** `npx vitest run tests/brand-limits.test.ts tests/admin-deal.test.ts` — Expected: PASS.
- [ ] **Step 5: Docs + commit** — tests.md rows 880 (the table and `brandLimit`), 881 (founder override via `/api/admin/plan`, range, audit row); `permissions.md` row for `/api/admin/plan` mentions `brands`. `git commit -m "feat(brands): brand limit per plan and founder override (880-881)"`.

### Task 2: Enforce the cap on add and restore

**Files:**
- Modify: `src/lib/brands.ts` (`addBrand`), `src/app/api/brands/route.ts` (add, archive-as-restore, GET), header comments of both files, the brands comment in `src/lib/pricing.ts`, and the `BRANDS_PER_HOUR` comment in `src/lib/rate.ts` (it says brands are unlimited and the rate is the only bound)
- Test: `tests/brand-limits.test.ts`, `tests/brand-guardrails.test.ts` (the rule-245 `describe` block near line 77)

**Interfaces:**
- Consumes: `brandLimit` (Task 1).
- Produces:
  - `activeCount(rows: BrandMeta[]): number` in `src/lib/brands.ts`.
  - `addBrand(u: User, name: string)` keeps its current return shape and adds `{ error: "brand_limit" }` — reads `brandLimit(u)` and refuses inside `withBrandsLock` when `activeCount(rows) >= limit`.
  - `GET /api/brands` → `{ ok, brands, active, cap, used }` (`used` = active count).
  - `POST /api/brands`: add → pre-check `used >= limit` before `brandAddRefusal` (no rate spent) → 402; then `addBrand`; `brand_limit` from inside the lock → 402. Archive on an archived row (restore) → 402 when `activeCount(rows) >= limit`, row unchanged.

- [ ] **Step 1: Failing tests** (rule 882):

```ts
it("Pro adds a 2nd brand, the 3rd is 402 brand_limit and spends no creation rate (rule 882)", async () => {
  await ownerOn("pro");
  expect((await add("B2")).status).toBe(200);
  const before = await creationRateCount(email);
  const r = await add("B3");
  expect(r.status).toBe(402);
  expect(await r.json()).toMatchObject({ error: "brand_limit", cap: 2, plan: "pro" });
  expect(await creationRateCount(email)).toBe(before);
});
it("two adds side by side at limit-1: one 200, one 402", async () => {
  await ownerOn("pro");
  const codes = (await Promise.all([add("X"), add("Y")])).map((r) => r.status).sort();
  expect(codes).toEqual([200, 402]);
  expect((await listBrands(email)).filter((b) => b.status === "active")).toHaveLength(2);
});
it("restore at the cap is 402 and the brand stays archived; archived brands do not count", async () => {
  await ownerOn("pro"); const id = await addId("B2");
  await post({ action: "archive", id });          // 1 active
  await add("B3");                                  // 2 active
  const r = await post({ action: "archive", id }); // restore: over the cap
  expect(r.status).toBe(402);
  expect((await listBrands(email)).find((b) => b.id === id)!.status).toBe("archived");
});
it("a lowered plan archives nothing", async () => {
  await ownerOn("business"); await add("2"); await add("3");
  await setPlan(email, "starter");
  expect((await listBrands(email)).filter((b) => b.status === "active")).toHaveLength(3);
  expect((await add("4")).status).toBe(402);
});
it("GET returns cap and used", async () => {
  await ownerOn("trial");
  expect(await (await brandsGet()).json()).toMatchObject({ cap: 1, used: 1 });
});
```

`creationRateCount` reads the hour bucket that `brandAddRefusal` increments (find its key in `src/lib/rate.ts`; build it from the test's own email, test-only).

- [ ] **Step 2: Run** `npx vitest run tests/brand-limits.test.ts` — Expected: FAIL (3rd add returns 200).
- [ ] **Step 3: Implement** the interfaces. Rewrite the rule-245 `describe` block in `brand-guardrails.test.ts`: keep its rate (429 `slow_down`, `Retry-After`) and lock (adds side by side, add beside rename, 409 `busy`) cases, run them on an `agency` account with `brandCap: 50` so the cap never interferes, and drop the "never 402 / no limit" assertions.
- [ ] **Step 4: Run** `npx vitest run tests/brand-limits.test.ts tests/brand-guardrails.test.ts` and `grep -ln "action: \"add\"" tests/` to find every other test that adds brands (e2e journey, members) — give those accounts a plan with room. Expected: all PASS.
- [ ] **Step 5: Docs + commit** — tests.md row 882; row 245 marked replaced; `flows.md` brand section; comments in `brands.ts`, `brands/route.ts`, `pricing.ts` no longer say unlimited. `git commit -m "feat(brands): enforce the plan's brand limit on add and restore (882)"`.

### Task 3: Brands page and site copy

**Files:**
- Modify: `src/components/app/BrandsPanel.tsx`, `src/lib/i18n.ts` (plan cards and the agencies line), `src/lib/app-i18n.ts`, `src/lib/pages-industry.ts`, `src/lib/site.ts`, and any other hit of the grep in Step 3
- Test: `tests/pricing-copy.test.ts` (the rule-248 case near line 91), `tests/brand-limits.test.ts`

**Interfaces:**
- Consumes: `PLAN_BRANDS`, `brandsText` (Task 1), `GET /api/brands` `cap`/`used` (Task 2).
- Produces: `limitNote(o: { ar: boolean; manage: boolean; used: number; cap: number; lang: Lang }): { text: string; href?: string } | null` exported from `BrandsPanel.tsx` (null below the cap).

Copy decisions:
- Starter card first feature: `brandsText(lang, PLAN_BRANDS.starter)` joined to the seats text with «، » / ", ". Pro and Business: one feature `brandsText(lang, PLAN_BRANDS.pro | business)` right after "everything in …". Agency: «علامات بحسب احتياج وكالتك» / "Brands sized to your agency".
- Agencies line and every other "any plan / unlimited brands" sentence: several brands from one account, «حسب الباقة» / "by plan", no number beyond the table.
- BrandsPanel header shows `used / cap` in `<b dir="ltr">`. At `used >= cap`: owner/admin (`manage`) get «وصلت حد باقتك من العلامات. رقِّ الباقة لإضافة علامة.» / "You've reached your plan's brand limit. Upgrade to add a brand." with `href` `/{lang}/app/billing`; members get «اطلب من مالك الحساب ترقية الباقة.» / "Ask the account owner to upgrade the plan.". A 402 `brand_limit` response shows the same note. Add and restore buttons disabled at the cap.

- [ ] **Step 1: Failing tests** (rule 883): replace the rule-248 pricing-copy case with:

```ts
it("each card states its brand count from PLAN_BRANDS and nothing says unlimited (rule 883)", () => {
  for (const lang of LANGS) {
    const card = (id: string) => dict[lang].pricing.plans.find((p) => p.id === id)!.features.join(" · ");
    expect(card("starter")).toContain(brandsText(lang, PLAN_BRANDS.starter));
    expect(card("pro")).toContain(brandsText(lang, PLAN_BRANDS.pro));
    expect(card("business")).toContain(brandsText(lang, PLAN_BRANDS.business));
  }
  const site = ["src/lib/i18n.ts", "src/lib/app-i18n.ts", "src/lib/pages-industry.ts", "src/lib/site.ts", "src/components/app/BrandsPanel.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
  expect(site).not.toMatch(/[Uu]nlimited brands|علامات بلا حد|على أي خطة/);
});
it("limitNote: owner gets the billing link, member gets ask-the-owner, null below the cap", () => {
  expect(limitNote({ ar: true, manage: true, used: 2, cap: 2, lang: "ar" })).toMatchObject({ href: "/ar/app/billing" });
  expect(limitNote({ ar: true, manage: false, used: 2, cap: 2, lang: "ar" })!.text).toContain("مالك الحساب");
  expect(limitNote({ ar: false, manage: true, used: 1, cap: 2, lang: "en" })).toBeNull();
});
```

(Use whatever names `pricing-copy.test.ts` already uses for the dictionary and language list.)

- [ ] **Step 2: Run** `npx vitest run tests/pricing-copy.test.ts tests/brand-limits.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the copy and panel changes; `grep -rn "بلا حد\|nlimited brand\|على أي خطة" src/` and fix each brand-related hit outside `changelog.ts`.
- [ ] **Step 4: Run** `npm run check` — Expected: green.
- [ ] **Step 5: Docs + commit** — tests.md row 883 (and rule 248's row text where it says unlimited). `git commit -m "feat(brands): plan brand count on pricing and brands page (883)"`.

### Task 4: Verify and open the PR

- [ ] **Step 1:** `npx next build` — Expected: success (or record why it is blocked locally).
- [ ] **Step 2:** Preview: a test account on Pro adds a second brand, the third shows the limit note; the pricing page (ar, en) shows 1 / 2 / 5 and the agency line; the founder sets a cap of 12 on an agency test account from `/ar/admin/users` and its brands page shows `n / 12`. Screenshots of the pricing cards and the brands page at the cap.
- [ ] **Step 3:** Push `claude/brand-limits`, open a draft PR naming rules 880-883, rule 245 replaced, the `/api/admin/plan` deviation, and "release step: expand only (new optional field `brandCap`), no data script". Bind it with the ccd_pr tools. Merge only on the founder's word.
