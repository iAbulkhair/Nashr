# Entitlements (Part A) Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built and merged as #299 (in `production`). The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pure function, `entitlements(u)`, says what an account's plan includes. The founder can give a trial account every video model until a date. The console and the billing page show what each account includes.

**Architecture:**
- **One new file** `src/lib/entitlements.ts`:
  - `entitlements(u)` is synchronous and wraps the existing helpers: `allowanceOf`, `seatLimit`, `chatAllowanceOf`, `chatCaps`, the conditions inside `trialOver`, and `billingLocked`.
  - It adds the one new dimension source, the dated `User.grants.video`.
  - `entitlementView(u)` adds use and reset dates with one `Promise.all`.
- **Callers:** the video start check and the inbox read the video list from it, the chat route and MCP `ask_noor` read the agents list, the founder plan route writes the grant.
- **No behaviour change** for any account without a grant.

**Tech Stack:** Next.js 16 app router, TypeScript, Upstash Redis via `src/lib/db.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md`, sections 3, 6.1 (entitlements table), 6.2, 9 and 10. Part B (agent scope, sections 4-5) gets its own plan later.

## Global Constraints

- **Branch:** `claude/entitlements-part-a`, cut from `claude/entitlements-agent-scope-spec`. Nothing is merged or deployed without the founder's explicit approval.
- **Setup:** the worktree has no `node_modules`, so first run `npm ci --cache "$TMPDIR/npm-cache"`.
- **Before every commit:** run `npm run check` (tsc, eslint, vitest). Run `npx next build` before the last commit; if it is blocked locally, say so, and CI is the proof.
- **Rule numbers:** this plan uses 780-786, each with a row in `docs/system/tests.md` added in the same commit as its test. 787-789 are spare. 790-809 belong to Part B.
- **Docs in the same commit** when a route or a permission changes: `docs/system/architecture.md`, `flows.md`, `permissions.md`. No new environment variables.
- **Redis:** no `await db.*` inside a loop (`Promise.all` or `pmap`).
- **Grants:**
  - Only `POST /api/admin/plan` (`adminActor`) writes them, under `withUserLock`, with an `admin:log` entry.
  - No other route reads a grant from a request.
- **Refusal codes stay as they are** (`plan_required`, `trial_over`, `trial_video_used`, …). The one new code is `agent_not_included`, which nothing triggers today.
- **Copy:** every owner-facing string exists in Arabic and English in `src/lib/app-i18n.ts` (`appDict`). No invented numbers: every figure shown comes from `entitlementView`.
- **Video grant scope:**
  - The grant opens every video model to a trial.
  - The trial's one-clip limit still applies (`TRIAL_VIDEOS`, the `trial_video_used` lock in `src/lib/media/jobs.ts:153`).
  - Whether a model is switched on (`availableModels`, `offModels`) stays a separate check.
- **`until`:**
  - Required on every grant, as a `YYYY-MM-DD` UTC day.
  - The grant holds through the end of that UTC day.
  - It must be after today and at most 366 days ahead.
  - This is narrower than the spec's optional `until`, on purpose: the existing overrides are already undated.

## Review Focus

1. **An expired grant left on the record** must read as the plan's own list, and the console must show it as expired, not active. Pinned in Task 1 (`ignores an expired grant`) and Task 4 (the `expired` flag in the view).
2. **A bad grant body must write nothing and log nothing**, and answer 400 `bad_grant`:
   - `until` that is today, in the past, more than 366 days ahead, or not a date;
   - a note over 200 characters;
   - a body that is not an object.

   Pinned in Task 3.
3. **A trial with a grant is still limited to one clip.** Its second video gets `trial_video_used`. Pinned in Task 2.
4. **A Paymob-locked subscription** reads as `active: false`, `inactive: "billing_locked"`, with `endsAt` set to its paid-through day. Today's gates refuse it as `trial_over`, and that stays. Pinned in Task 1.
5. **A plan change keeps the grant.** The grant is per dimension; only `videoGrant: null` clears it. Pinned in Task 3.

---

### Task 1: `entitlements(u)` and the grant type (rule 780)

**Files:**
- Create: `src/lib/entitlements.ts`
- Modify: `src/lib/auth.ts` (the `User` type gets `grants?`, after `deal?`)
- Test: `tests/entitlements.test.ts`
- Docs: `docs/system/tests.md` (row 780), `docs/system/architecture.md` (one line under lib files), `docs/system/permissions.md` (how `active`, `inactive` and `endsAt` read the suspension, the trial and the Paymob subscription; spec 10)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/auth.ts
  export type Grant<T> = { value: T; until: string; by: string; at: string; note?: string };
  // User: grants?: { video?: Grant<"all"> };

  // src/lib/entitlements.ts
  export type Inactive = "suspended" | "trial_over" | "billing_locked";
  export type Entitlements = {
    active: boolean; inactive?: Inactive; endsAt: string | null;
    credits: { monthly: number }; seats: number;
    chat: { monthly: number; hour: number; day: number };
    media: { video: readonly VideoModelId[] };
    agents: readonly AgentId[];
  };
  export type EntUser = Pick<User, "plan" | "trialEnds" | "suspended" | "billing" | "seats" | "deal" | "chatAllowance" | "grants">;
  export const ALL_VIDEO_MODELS: readonly VideoModelId[];        // MEDIA_MODELS filtered to kind "video", catalog order
  export function grantActive(g: Grant<unknown> | undefined, now?: number): boolean;
  export function entitlements(u: EntUser, now?: number): Entitlements;
  ```

- [ ] **Step 1: Write the failing tests** in `tests/entitlements.test.ts`. These tests are pure and need no db. Build users with a small `user(p: Partial<EntUser>)` helper whose defaults are plan `"pro"`, `trialEnds` far in the future and no extras.

```ts
const NOW = Date.parse("2026-10-08T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86400_000).toISOString().slice(0, 10);
const grant = (until: string) => ({ video: { value: "all" as const, until, by: "founder@x", at: "2026-10-08T00:00:00Z" } });

it("matches the old helpers for every plan and override", () => {
  const cases: EntUser[] = [
    user({ plan: "trial" }), user({ plan: "starter" }), user({ plan: "pro" }), user({ plan: "business" }),
    user({ plan: "agency" }), user({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "y" } }),
    user({ plan: "pro", seats: 9 }), user({ plan: "starter", chatAllowance: 0 }), user({ plan: "pro", chatAllowance: 900 }),
  ];
  for (const u of cases) {
    const e = entitlements(u, NOW);
    expect(e.credits.monthly).toBe(allowanceOf(u));
    expect(e.seats).toBe(seatLimit(u));
    expect(e.chat.monthly).toBe(chatAllowanceOf(u));
    expect({ hour: e.chat.hour, day: e.chat.day }).toEqual({ ...chatCaps(u) });
    expect(e.agents).toEqual(AGENT_IDS);
    expect(e.active).toBe(true);
  }
});
it("a trial includes the trial video models; a paid plan every video model", () => {
  expect(entitlements(user({ plan: "trial" }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
  expect(entitlements(user({ plan: "pro" }), NOW).media.video).toEqual(ALL_VIDEO_MODELS);
  expect(ALL_VIDEO_MODELS).toEqual(["vid-quick", "vid-sound", "vid-premium", "vid-cinematic", "vid-motion"]);
});
it("a video grant opens every model to a trial through the end of its day", () => {
  const u = user({ plan: "trial", grants: grant(day(0)) });
  expect(entitlements(u, NOW).media.video).toEqual(ALL_VIDEO_MODELS);
  expect(entitlements(u, Date.parse(`${day(0)}T23:59:59.999Z`)).media.video).toEqual(ALL_VIDEO_MODELS);
});
it("ignores an expired grant", () => {
  expect(entitlements(user({ plan: "trial", grants: grant(day(-1)) }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
  expect(grantActive(grant(day(-1)).video, NOW)).toBe(false);
  expect(grantActive(undefined, NOW)).toBe(false);
  expect(grantActive({ ...grant(day(3)).video, until: "not-a-day" }, NOW)).toBe(false);
  expect(grantActive({ ...grant(day(3)).video, by: "" }, NOW)).toBe(false);   // a grant needs by and at (spec 9)
  expect(grantActive({ ...grant(day(3)).video, at: "" }, NOW)).toBe(false);
});
it("inactive: suspended, ended trial, locked Paymob subscription", () => {
  const suspended = user({ suspended: true });
  const ended = user({ plan: "trial", trialEnds: "2026-10-01T00:00:00Z" });
  const locked = user({ plan: "pro", billing: { ...billingFixture(), status: "locked", paidThrough: "2026-10-05" } });
  expect(entitlements(suspended, NOW)).toMatchObject({ active: false, inactive: "suspended" });
  expect(entitlements(ended, NOW)).toMatchObject({ active: false, inactive: "trial_over", endsAt: "2026-10-01T00:00:00Z" });
  expect(entitlements(locked, NOW)).toMatchObject({ active: false, inactive: "billing_locked", endsAt: "2026-10-05" });
  for (const u of [suspended, ended, locked]) {   // inactive accounts still report the plan's own numbers
    const e = entitlements(u, NOW);
    expect([e.credits.monthly, e.seats, e.chat.monthly]).toEqual([allowanceOf(u), seatLimit(u), chatAllowanceOf(u)]);
  }
});
it("endsAt: the trial end, the Paymob paid-through day, or null when activated by hand", () => {
  expect(entitlements(user({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" }), NOW).endsAt).toBe("2026-10-20T00:00:00Z");
  expect(entitlements(user({ plan: "pro", billing: { ...billingFixture(), status: "active", paidThrough: "2026-11-08" } }), NOW).endsAt).toBe("2026-11-08");
  expect(entitlements(user({ plan: "pro" }), NOW).endsAt).toBeNull();
});
```

`billingFixture()` builds a valid `Billing` (`src/lib/billing-state.ts`). Read that type for the required fields and use synthetic values only.

- [ ] **Step 2: Run** `npx vitest run tests/entitlements.test.ts`. Expected: FAIL, because `src/lib/entitlements.ts` does not exist.

- [ ] **Step 3: Add `Grant` and `User.grants`** in `src/lib/auth.ts`. Give `grants` a doc comment in the style of the neighbouring fields. It says three things:
  - only `POST /api/admin/plan` writes it, under `withUserLock`;
  - only `entitlements()` reads it;
  - an expired grant is ignored, never deleted.

- [ ] **Step 4: Implement `src/lib/entitlements.ts`.**
  - **`grantActive`:** true when all three hold:
    - `by` and `at` are non-empty;
    - `until` matches `/^\d{4}-\d{2}-\d{2}$/`;
    - `now <= Date.parse(`${until}T23:59:59.999Z`)`.
  - **`inactive`:** checked in this order, using the passed `now`:
    1. `suspended`;
    2. `billing_locked`, from `billingLocked(u.billing)`;
    3. `trial_over`, when `plan === "trial"` and `Date.parse(trialEnds) < now`.
  - **`endsAt`:** `trialEnds` for a trial, otherwise `u.billing?.paidThrough ?? null`.
  - **`media.video`:** `TRIAL_VIDEO_MODELS` when the plan is `"trial"` and the video grant is not active; otherwise `ALL_VIDEO_MODELS`. This keeps today's `u.plan === "trial"` rule.
  - **Everything else** comes from the existing helpers, unchanged.
  - **File header comment:** name the spec and say what is deliberately outside the layer (spec 3.1).

- [ ] **Step 5: Run** `npx vitest run tests/entitlements.test.ts`. Expected: PASS.

- [ ] **Step 6: Add row 780** to `docs/system/tests.md`:
  - `entitlements(u)` equals the old helpers for every plan and override (the equivalence table);
  - a dated video grant is honoured through its last UTC day and ignored after;
  - `inactive` and `endsAt` read the suspension, the trial and the Paymob subscription.

  Add the architecture line. Then run `npm run check` and commit:

```bash
git add src/lib/entitlements.ts src/lib/auth.ts tests/entitlements.test.ts docs/system/tests.md docs/system/architecture.md docs/system/permissions.md
git commit -m "feat(entitlements): one pure function for what a plan includes (rule 780)"
```

---

### Task 2: callers read the video and agents lists (rules 781, 782)

**Files:**
- Modify:
  - `src/lib/media/start.ts:98`
  - `src/app/[lang]/app/page.tsx:29`
  - `src/components/app/Inbox.tsx:468` (props)
  - `src/components/app/MediaControls.tsx:7,171`
  - `src/app/api/chat/route.ts:39-44` (between `const agent` and `trialOver`)
  - `src/app/api/mcp/route.ts:81-88` (`ask_noor`, before `trialOver(user)`)
- Test: `tests/media-routes.test.ts` (new cases after case 13), `tests/entitlements-scan.test.ts` (create)
- Docs: `docs/system/tests.md` (rows 781, 782), `docs/system/flows.md` (the video start reads `entitlements(u).media.video`)

**Interfaces:**
- Consumes: `entitlements(u, now?)` from Task 1.
- Produces:
  - `Inbox` and `MediaControls` take `included: readonly VideoModelId[]`, the plan's video models.
    - It replaces the `plan === "trial"` test in `MediaControls`.
    - The `plan` prop stays, for `shortOfCredits`.
  - The chat route answers 403 `{ ok: false, error: "agent_not_included" }`.
  - MCP `ask_noor` answers a tool error before any count: "This agent is not included in this account's plan. Nothing was sent."

- [ ] **Step 1: Write the failing tests.**

In `tests/media-routes.test.ts`, next to case 13, using the same helpers (`mediaEnv`, `kieFake`, `useDeps`, `owner`, `start`, `taskFor`, `balance`):

```ts
it("13b. a founder video grant opens every model to a trial, still one clip", async () => {
  mediaEnv({ kie: true, blob: true, models: "all" });
  useDeps({ kie: kieFake() });
  const u = await owner();
  const until = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  await saveUser({ ...(await getUser(u.email))!, grants: { video: { value: "all", until, by: "founder@x", at: new Date().toISOString() } } });
  const g = (await getUser(u.email))!;
  expect((await start("video", g, await taskFor(g), { model: "vid-premium" })).status).toBe(202);
  const second = await start("video", g, await taskFor(g), { model: "vid-quick" });
  expect([second.status, second.body.error]).toEqual([402, "trial_video_used"]);
});
it("13c. an expired grant changes nothing", async () => {
  // same setup with until = yesterday → vid-premium is [402, "plan_required"] and the balance is unchanged
});
```

In `tests/entitlements-scan.test.ts`, read the source files with `readFileSync`, the way `tests/scope-usage.test.ts` does:

```ts
it("TRIAL_VIDEO_MODELS is read only by the catalog and entitlements", () => {
  const users = filesUnder("src").filter((f) => /\bTRIAL_VIDEO_MODELS\b/.test(read(f)));
  expect(users.sort()).toEqual(["src/lib/entitlements.ts", "src/lib/media-catalog.ts"]);
});
it("the chat route and MCP ask_noor check the agents dimension", () => {
  expect(read("src/app/api/chat/route.ts")).toMatch(/entitlements\(u\)\.agents\.includes\(agent\)/);
  expect(read("src/app/api/mcp/route.ts")).toMatch(/entitlements\(user\)\.agents\.includes\("noor"\)/);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/media-routes.test.ts tests/entitlements-scan.test.ts`. Expected: FAIL. In 13b, `vid-premium` gets `plan_required`, and the scan finds `start.ts` and `MediaControls.tsx`.

- [ ] **Step 3: Implement.**
  - **`start.ts:98`:** becomes `if (!entitlements(u).media.video.includes(model)) return refuse(402, "plan_required");`.
  - **`page.tsx`:** passes `included={entitlements(u).media.video}` to `Inbox`.
  - **`Inbox`:** passes it to `MediaControls`.
  - **`MediaControls:171`:** becomes `m.kind === "video" && !included.includes(m.id as VideoModelId)`. Drop the `TRIAL_VIDEO_MODELS` import.
  - **Chat route:** right after `const agent = …` (line 39), add `if (!entitlements(u).agents.includes(agent)) return NextResponse.json({ ok: false, error: "agent_not_included" }, { status: 403 });`. It sits before `trialOver`, so nothing is counted.
  - **MCP `ask_noor`:** the same check as a tool error, before `trialOver(user)`.

- [ ] **Step 4: Run** the two test files. Expected: PASS. Then run the full `npx vitest run tests/media-routes.test.ts`; case 13 must be unchanged.

- [ ] **Step 5: Docs.**
  - **Row 781:**
    - the video models a plan includes come only from `entitlements(u).media.video`, which the start route and the inbox read;
    - `TRIAL_VIDEO_MODELS` is read only by the catalog and entitlements;
    - a grant does not lift the one-clip trial limit.
  - **Row 782:** the chat route and MCP `ask_noor` refuse an agent the plan does not include, before any count. Today every plan includes all eight.
  - **`flows.md`:** note the video start step.

  Then run `npm run check` and commit:

```bash
git add src/lib/media/start.ts "src/app/[lang]/app/page.tsx" src/components/app/Inbox.tsx src/components/app/MediaControls.tsx src/app/api/chat/route.ts src/app/api/mcp/route.ts tests/media-routes.test.ts tests/entitlements-scan.test.ts docs/system/tests.md docs/system/flows.md
git commit -m "feat(entitlements): video and agent checks read entitlements (rules 781-782)"
```

---

### Task 3: the founder's video grant (rule 783)

**Files:**
- Modify: `src/app/api/admin/plan/route.ts`
  - POST: body, validation, the write under the lock, `what`, `before`/`after`, and the response.
  - GET: rows add `videoGrant`.
- Modify: `src/lib/entitlements.ts` (`parseVideoGrant`)
- Test: `tests/entitlements-grant.test.ts` (create). Same setup as `tests/admin-deal.test.ts`: `adminSignIn`, `json`, `newUser`, the stubbed admin key.
- Docs: `docs/system/tests.md` (row 783), `docs/system/permissions.md` (the founder console can open every video model to one account until a date)

**Interfaces:**
- Consumes: `Grant`, `User.grants` (Task 1).
- Produces: `POST /api/admin/plan` accepts `videoGrant: { until: "YYYY-MM-DD", note?: string } | null`.
  - **Success:** 200, with `user.videoGrant: Grant<"all"> | null`.
  - **Bad body:** 400 `bad_grant`.
  - **GET row:** gains `videoGrant: Grant<"all"> | null`.
  - **`admin:log`:**
    - `what` gains `video:all@{until}` or `video:plan`;
    - `before` and `after` gain `video: "all@{until}" | "plan"`.
  - **Validation helper:** `export function parseVideoGrant(v: unknown, now?: number): { ok: true; until: string; note?: string } | { ok: false }`. It lives in `src/lib/entitlements.ts` so the console can run the same check.

- [ ] **Step 1: Write the failing tests** in `tests/entitlements-grant.test.ts`:

```ts
it("sets a dated video grant, logged before and after", async () => {
  const u = await account("trial");
  const until = dayFromNow(14);
  const r = await call(u.email, { videoGrant: { until, note: "demo for agency lead" } });
  expect(r.status).toBe(200);
  const g = (await getUser(u.email))!.grants?.video;
  expect(g).toMatchObject({ value: "all", until, note: "demo for agency lead" });
  expect(g!.by).toBeTruthy(); expect(Date.parse(g!.at)).not.toBeNaN();
  const log = await lastLog();
  expect(log.what).toContain(`video:all@${until}`);
  expect([log.before.video, log.after.video]).toEqual(["plan", `all@${until}`]);
});
it("refuses a bad grant and writes nothing", async () => {
  const u = await account("trial");
  const n = await logLength();
  for (const bad of [{ until: dayFromNow(0) }, { until: dayFromNow(-2) }, { until: dayFromNow(367) }, { until: "2026-13-40" }, { until: "soon" }, {}, "all", 5, { until: dayFromNow(3), note: "x".repeat(201) }]) {
    const r = await call(u.email, { videoGrant: bad });
    expect([r.status, (await r.json()).error]).toEqual([400, "bad_grant"]);
  }
  expect((await getUser(u.email))!.grants).toBeUndefined();
  expect(await logLength()).toBe(n);
});
it("null clears the grant; a plan change keeps it", async () => {
  const u = await account("trial");
  await call(u.email, { videoGrant: { until: dayFromNow(5) } });
  await call(u.email, { plan: "pro" });
  expect((await getUser(u.email))!.grants?.video).toBeTruthy();
  await call(u.email, { videoGrant: null });
  expect((await getUser(u.email))!.grants?.video).toBeUndefined();
  expect((await lastLog()).what).toContain("video:plan");
});
it("needs the founder", async () => {
  jar().clear();
  const u = await account("trial");
  expect((await call(u.email, { videoGrant: { until: dayFromNow(5) } })).status).toBe(401);
});
it("the GET row shows the grant", async () => { /* set one, GET, row.videoGrant.until equals it */ });
```

`dayFromNow(n)` is the UTC `YYYY-MM-DD` day n days from now.

- [ ] **Step 2: Run** `npx vitest run tests/entitlements-grant.test.ts`. Expected: FAIL, because `videoGrant` is ignored.

- [ ] **Step 3: Implement.**
  - **Parse first, with the other fields:** call `parseVideoGrant(b.videoGrant)` when `videoGrant` is present and not null. A failure answers `400 bad_grant` before the user is read.
  - **`until`:**
    - a real `YYYY-MM-DD` day: the `Date` round-trip gives back the same string;
    - after today (UTC);
    - at most 366 days ahead.
  - **`note`:** optional, at most 200 characters, collapsed to one line.
  - **Under `withUserLock`:**
    - set: `u.grants = { ...u.grants, video: { value: "all", until, by: who, at: now, ...(note ? { note } : {}) } }`;
    - clear: delete `u.grants.video`, then delete `u.grants` when it is empty;
    - extend `what`, `before` and `after`.
  - **GET:** each row adds `videoGrant: u.grants?.video ?? null`.

- [ ] **Step 4: Run** the test file. Expected: PASS. Then run `npx vitest run tests/admin-deal.test.ts`, which must stay green.

- [ ] **Step 5: Docs.**
  - **Row 783:** a founder video grant is validated, written only by `POST /api/admin/plan` under `withUserLock`, and logged before and after. It survives a plan change and is cleared only by `null`.
  - **Route comment:** document `videoGrant` in the route's header comment.
  - **`permissions.md`:** add the console permission.

  Then run `npm run check` and commit:

```bash
git add src/app/api/admin/plan/route.ts src/lib/entitlements.ts tests/entitlements-grant.test.ts docs/system/tests.md docs/system/permissions.md
git commit -m "feat(admin): dated video grant per account (rule 783)"
```

---

### Task 4: `entitlementView` and the founder's entitlements table (rule 784)

**Files:**
- Modify:
  - `src/lib/entitlements.ts`
  - `src/app/api/admin/users/[email]/route.ts` (GET adds `entitlements`)
  - `src/components/app/AdminConsole.tsx` (the detail panel under the summary cards, plus a "Video grant" button next to "Extend trial" at line 660)
- Create: `src/components/app/EntitlementsTable.tsx`
- Test: `tests/entitlements.test.ts` (the view), `tests/entitlements-grant.test.ts` (the detail GET)
- Docs: `docs/system/tests.md` (row 784)

**Interfaces:**
- Consumes: `entitlements`, `grantActive`, `parseVideoGrant`; `seatsUsed` (`src/lib/team.ts`); `chatStatus`, `ChatStatus` (`src/lib/chat-allowance.ts`).
- Produces:
  ```ts
  export type EntitlementView = {
    ent: Entitlements;
    used: { credits: number; seats: number; chat: ChatStatus };
    resetsAt: string | null;              // next 1st of the month (UTC day) for a paid plan; null for a trial
    grants: { video: (Grant<"all"> & { expired: boolean }) | null };
  };
  export async function entitlementView(u: User, now?: number): Promise<EntitlementView>;
  // EntitlementsTable: ({ view, lang }: { view: EntitlementView; lang: "ar" | "en" }) => JSX
  ```

- [ ] **Step 1: Write the failing tests.**
  - **`entitlementView`** on a db-backed trial account with an expired grant:
    - `used.seats` equals `seatsUsed(u.email)`;
    - `used.chat` equals `chatStatus(u)`;
    - `used.credits === u.credits`;
    - `resetsAt === null`;
    - `grants.video.expired === true`;
    - `ent.media.video` equals `TRIAL_VIDEO_MODELS`.
  - **Paid account:** `resetsAt` is the next 1st of the month as `YYYY-MM-DD`.
  - **Detail GET** (`adminUser.GET`): its JSON has `entitlements.ent.seats` equal to `seatLimit(u)`.

- [ ] **Step 2: Run** them. Expected: FAIL, because `entitlementView` does not exist.

- [ ] **Step 3: Implement.**
  - **`entitlementView`:** one `Promise.all([seatsUsed(u.email), chatStatus(u)])`, no writes.
  - **Detail GET:** add `entitlements: await entitlementView(u)`, folded into the route's existing `Promise.all`, not a second await.
  - **`EntitlementsTable`:**
    - one row per dimension: credits, seats, chat month, chat hour/day, video models, agents, active / ends;
    - columns: plan, override (value, until, who, note), effective, used, resets;
    - an expired grant is greyed out with the word "expired" / «منتهية».
  - **"Video grant" button:**
    - prompts for the day and a note, and checks them with `parseVideoGrant`;
    - POSTs `videoGrant` to `/api/admin/plan`, then reloads the detail, the way `setChat` does;
    - an empty answer sends `null`.

- [ ] **Step 4: Run** the tests. Expected: PASS. Then check the table in the browser:
  - open the console locally with `preview_start`, sign in with the key session, open a trial account;
  - check the table renders in both languages;
  - if the preview cannot run, say so.

- [ ] **Step 5: Add row 784:**
  - `entitlementView` is read-only (one `Promise.all`);
  - the console detail shows every dimension with plan value, override, effective value, use and reset;
  - it marks an expired grant.

  Then run `npm run check` and commit:

```bash
git add src/lib/entitlements.ts "src/app/api/admin/users/[email]/route.ts" src/components/app/AdminConsole.tsx src/components/app/EntitlementsTable.tsx tests/entitlements.test.ts tests/entitlements-grant.test.ts docs/system/tests.md
git commit -m "feat(admin): entitlements table per account (rule 784)"
```

---

### Task 5: the owner's "What your plan includes" card (rule 785)

**Files:**
- Create: `src/components/app/PlanIncludesCard.tsx` (server component, no client state)
- Modify: `src/app/[lang]/app/billing/page.tsx`
  - Replace `Promise.all([seatsUsed(u.email), chatStatus(u)])` with `entitlementView(u)`.
  - Read `used.seats` and `used.chat` from the view.
  - Render the card above `ChatAllowanceCard`.
- Modify: `src/lib/app-i18n.ts` (`billing.includes`, both languages)
- Test: `tests/entitlements-card.test.ts` (render the card for a fixed view with `renderToStaticMarkup` from `react-dom/server`)
- Docs: `docs/system/tests.md` (row 785)

**Interfaces:**
- Consumes: `EntitlementView` (Task 4).
- Produces: `PlanIncludesCard({ view, lang }: { view: EntitlementView; lang: "ar" | "en" })`.

- [ ] **Step 1: Write the failing test.**
  - **Fixed paid view:** pro, 3 of 5 seats, chat 40 of 650, all video models, eight agents. The markup contains:
    - the credits number;
    - `3 / 5` and `40 / 650`;
    - the label of each included video model from `MEDIA_MODELS`;
    - "8";
    - the scope sentence in that language.
  - **Trial view:** the markup lists only the three trial models and shows the trial end day.
  - **No number in the copy** that does not come from the view.

- [ ] **Step 2: Run** it. Expected: FAIL, because the card does not exist.

- [ ] **Step 3: Implement the card and the strings.** The scope sentence, exactly:
  - **EN:** "Your Thakeen team works on marketing, sales, growth, finance and analytics for your brands."
  - **AR:** «يعمل فريق ذكين على التسويق والمبيعات والنمو والمالية والتحليلات لعلاماتك التجارية.»

- [ ] **Step 4: Run** the test. Expected: PASS. Then open `/{lang}/app/billing` in the preview for a trial and a paid account, in both languages, at phone width. If the preview cannot run, say so.

- [ ] **Step 5: Add row 785:** the billing page shows what the plan includes from `entitlementView`, with no number of its own, plus the one scope sentence. Then run `npm run check` and commit:

```bash
git add src/components/app/PlanIncludesCard.tsx "src/app/[lang]/app/billing/page.tsx" src/lib/app-i18n.ts tests/entitlements-card.test.ts docs/system/tests.md
git commit -m "feat(billing): what your plan includes card (rule 785)"
```

---

### Task 6: pin the plan comparisons, final checks (rule 786)

**Files:**
- Modify: `tests/entitlements-scan.test.ts`
- Docs: `docs/system/tests.md` (row 786). Do a final read of `architecture.md`, `flows.md` and `permissions.md` against what was built.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the test.** It counts `plan === "trial"` and `plan !== "trial"` per file under `src` and compares the counts with an `ALLOWED` map.
  - **Starting counts:** generate them with `git grep -c 'plan === "trial"\|plan !== "trial"' -- src`. The 2026-10-08 list has 20 files.
  - **Base the map on the counts after Task 2:** `src/lib/media/start.ts` and `src/components/app/MediaControls.tsx` drop out, and `src/lib/entitlements.ts` comes in.
  - **Each map entry** carries a one-line reason.
  - **A new file or a higher count fails** with the message "decide access in src/lib/entitlements.ts, or add a display-only use here with a reason".

- [ ] **Step 2: Run** it. Expected: PASS on the current tree. Then add one comparison to a scratch copy of a file, check that the test fails, and revert.

- [ ] **Step 3: Add row 786.** Then run the full gate:
  - `npm run check`: all green;
  - `npx next build`: green, or say plainly that it is blocked locally and CI is the proof.

- [ ] **Step 4: Commit and push the branch** (a branch, not main), then report to the founder.
  - **Report:** the commits, the rules, and what the founder can try: a video grant on a trial account in the console, then the billing card.
  - **PR:** open one only on the founder's word.

```bash
git add tests/entitlements-scan.test.ts docs/system/tests.md
git commit -m "test(entitlements): pin plan comparisons outside entitlements (rule 786)"
git push -u origin claude/entitlements-part-a
```
