# Social post results through Composio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Instagram results and LinkedIn company-page results through Composio, read only, for Dana's reports
and the Reports page. Then let the owner publish to LinkedIn as the page.

**Architecture:** A new `src/lib/social-stats.ts` mirrors `src/lib/site-stats.ts`:
- A daily read through `composioRead` writes one snapshot, `socialstats:{scope}`.
- A `<social_data>` block feeds Dana, and a `SocialStats` card feeds the Reports page.
- LinkedIn pages are listed at connect time and chosen through `/api/connect/linkedin`, the same way Meta pages are.
- "Post as page" only swaps the `author` of the existing LinkedIn publish call.

**Tech Stack:** Next.js 16 app router, TypeScript, Upstash Redis via `src/lib/db.ts`, `@composio/core` 0.22.0 via
`src/lib/connectors/composio.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-social-results-via-composio-design.md` (approved 2026-10-08).

## Global Constraints

- Read only. The new tools go only in `read` in `composio-catalog.ts`; phases 1–2 add no write tool.
- "Post as page" changes only the `author` of `LINKEDIN_CREATE_LINKED_IN_POST`.
- The scope comes from `sc(u)` or the cron's user record. The ig id, org URN and post ids are never taken from a
  request.
- `null` means "not read", never zero. The UI shows «—» for null.
- Window: 28 days. At most 30 Instagram posts, list page `limit: 25`, `pmap` concurrency 4.
- Instagram metrics are `views, reach, likes, comments, saved, shares`. The fallback is `reach, likes, comments,
  saved`. Never `impressions`, `plays` or `engagement`.
- The sync is due after 20 hours (`DUE_MS = 20 * 36e5`), and the read counts as stale after 7 days.
- Captions go through `clean(s, 80)` from `src/lib/perf-import.ts`. A post `url` is kept only when its host is
  `instagram.com` or `www.instagram.com`. Never store `paging.next`.
- Errors are kept as short codes only (`errCode`-style), never response bodies.
- No `await db.*` inside a loop: use `pmap` or `Promise.all`.
- Rule numbers 661–671. Check `docs/system/tests.md` for clashes before writing rows. Docs are updated in the same
  commit as the code.
- Run `npm run check` before every commit. Push to `claude/composio-api-install-1d5bfc` (PR #272) only. No merge, and
  no production change, without the founder's explicit approval.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Deviation from the spec (flag it to the founder in the hand-off):** the spec says `fromThakeen` reads the task list
once per sync.
- `listTasks` costs about 200 Redis calls, and `publish-once.ts:109` stores `id` only for WordPress.
- The plan instead stores the id in `Task.published` for instagram and linkedin (as the spec requires for LinkedIn),
  and also adds the Instagram id to a small set, `socialpub:{scope}`. The sync then reads that set with one
  `smembers`.
- Posts published before this change are not marked «من ذكين».

## Review Focus

1. **Meta connection with no Instagram account** (`data.instagram` or `meta.igId` missing). The Instagram part is
   skipped and does not count as a failure: no `igError`, and the read does not throw. Test in Task 4.
2. **A refused or expired Instagram token** (error text that maps to 401). It must throw so `refusedToken` marks
   reconnect, not leave the post with nulls. Test in Task 4.
3. **A cross-scope `fromThakeen` leak:** a post id published by workspace A is never marked for workspace B. Test in
   Task 4 (rule 665).
4. **Re-connecting LinkedIn rebuilds `meta`**, which drops `liPostAs`. The next post goes as the person, never as a
   stale page. Test in Task 9.
5. **Instagram answers nested as `data.data`, and a last page whose cursor repeats.** The list must stop rather than
   loop. Test in Task 4.

---

## Phase 1 — Instagram results

### Task 1: Measure the tools at the pinned versions

**Files:** none changed unless a pin moves (`src/lib/connectors/composio.ts:45-60`).

- [ ] **Step 1:** List the arguments of each new tool with the CLI, sandbox off:
  `composio execute <SLUG> --get-schema`, for `INSTAGRAM_GET_USER_INSIGHTS`, `INSTAGRAM_GET_IG_USER_MEDIA`,
  `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`, `LINKEDIN_GET_COMPANY_INFO`, `LINKEDIN_GET_SHARE_STATS` and
  `LINKEDIN_GET_NETWORK_SIZE`. Write down the exact argument names in the commit message of Task 2. Expected:
  - `INSTAGRAM_GET_USER_INSIGHTS`: `ig_user_id, metric, period, metric_type, since, until`.
  - `INSTAGRAM_GET_IG_USER_MEDIA`: `ig_user_id, fields, limit, since, after`.
  - `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`: `ig_media_id, metric`.
  - `LINKEDIN_GET_COMPANY_INFO`: `start, count`.
  - `LINKEDIN_GET_SHARE_STATS`: `organizational_entity, time_intervals`.
  - `LINKEDIN_GET_NETWORK_SIZE`: `organization_id`.
- [ ] **Step 2:** The CLI shows only the latest version. Pin existence at `instagram: "20251229_00"` and
  `linkedin: "20250915_00"` is proven on Preview in Task 6, Step 6. If Vercel logs then show a tool-version error for a
  new slug, bump only that toolkit's pin in `TOOLKIT_VERSION`, push, and re-run that toolkit's publish smoke test
  before going on.

### Task 2: Catalog reads (rule 661)

**Files:**
- Modify: `src/lib/connectors/composio-catalog.ts:37-53` (instagram and linkedin `read`), and the header comment.
- Test: `tests/composio-social.test.ts` (new). Copy the `fake()` harness, `ok`, `via` and `beforeEach`/`afterEach` from
  `tests/composio-reads.test.ts:19-56`, with `COMPOSIO_PROVIDERS="meta,linkedin"`.

**Interfaces:** Produces the catalog entries used by Tasks 4, 7 and 8, with the argument names from Task 1 Step 1.

- [ ] **Step 1: Write the failing test**

```ts
const NEW_READS = { instagram: ["INSTAGRAM_GET_USER_INSIGHTS", "INSTAGRAM_GET_IG_USER_MEDIA", "INSTAGRAM_GET_IG_MEDIA_INSIGHTS"],
  linkedin: ["LINKEDIN_GET_COMPANY_INFO", "LINKEDIN_GET_SHARE_STATS", "LINKEDIN_GET_NETWORK_SIZE"] } as const;
describe("social results are reads only (rule 661)", () => {
  it("lists each new tool as a read and never as a write", () => {
    for (const [tk, slugs] of Object.entries(NEW_READS)) for (const s of slugs) {
      expect(Object.keys(TOOLKITS[tk as Toolkit].read)).toContain(s);
      for (const t of Object.values(TOOLKITS)) expect(Object.keys(t.write)).not.toContain(s);
    }
  });
  it("refuses a new read slug through composioWrite", async () => {
    await expect(composioWrite("s1", "instagram", "INSTAGRAM_GET_IG_USER_MEDIA", { ig_user_id: "1" }, "ca_1")).rejects.toThrow("composio_tool_not_allowed");
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/composio-social.test.ts`. Expect FAIL: `expected [...] to contain
  'INSTAGRAM_GET_USER_INSIGHTS'`.
- [ ] **Step 3:** Add the six slugs with their Task 1 argument lists to `read`. Add one header line: "Instagram and
  LinkedIn page results are reads (rule 661, spec 2026-10-08-social-results)".
- [ ] **Step 4:** Run it again. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Add a row for 661 to `docs/system/tests.md`. Commit with
  `feat: catalog reads for Instagram and LinkedIn page results (rule 661)`.

### Task 3: Keep the post id on publish (Instagram + LinkedIn)

**Files:**
- Modify: `src/lib/publish-once.ts:109`.
- Modify: `src/lib/account.ts:113` (wipe list).
- Test: `tests/composio-social.test.ts`.

**Interfaces:**
- Produces: `Task.published[].id` set for providers `wordpress`, `instagram` and `linkedin`.
- Produces: the Redis set `socialpub:{scope}`, which holds Instagram media ids published by Thakeen and has a 90-day
  TTL (`db.expire`, refreshed on each add).
- Produces: `export const SOCIAL_PUB_KEY = (scope: string) => \`socialpub:${scope}\`` in `src/lib/social-stats.ts`.
  Create the file with only this export now.

- [ ] **Step 1: Write the failing test.** Publish an approved test task to instagram through the Composio fake (follow
  the existing instagram publish test in `tests/composio.test.ts`). Then:

```ts
expect(task.published?.at(-1)).toMatchObject({ provider: "instagram", id: "17900000000000001" });
expect(await db.smembers(SOCIAL_PUB_KEY(scope))).toEqual(["17900000000000001"]);
// wipeAccount clears it
await wipeAccount(email); expect(await db.smembers(SOCIAL_PUB_KEY(scope))).toEqual([]);
```

- [ ] **Step 2:** Run it. Expect FAIL: `id` is undefined.
- [ ] **Step 3:** In `publish-once.ts:109`, keep `id` when `r.provider` is one of `wordpress`, `instagram` or
  `linkedin` and `r.id` is set. For `instagram`, add `db.sadd` and `db.expire` (90 days) next to the `updateTask` call
  inside the existing `Promise.all` or `quietly` pattern. It must not be awaited in a loop, and a failure there must
  not fail the publish. Add `SOCIAL_PUB_KEY(s)` to the wipe list.
- [ ] **Step 4:** Run it. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Commit with `feat: keep Instagram and LinkedIn post ids on publish`.

### Task 4: Instagram reader and snapshot (rules 662, 663, 664, 665, 667)

**Files:**
- Modify: `src/lib/social-stats.ts`.
- Modify: `src/lib/account.ts:113` (add `socialstats:${s}`).
- Test: `tests/composio-social.test.ts`.

**Interfaces:**
- Consumes: `composioRead`; `accountOf`, `listOf`, `num`, `at`, `pick` and `isComposio` from `composio-shape.ts`;
  `clean`; `pmap`; `SOCIAL_PUB_KEY`; `getConnection`.
- Produces:
  - The types `IgPost`, `Ig`, `Li` and `SocialSnapshot`, exactly as in the spec's Store section.
  - `export const SOCIAL_KEY = (scope: string) => \`socialstats:${scope}\``.
  - `export async function getSocialSnapshot(scope: string): Promise<SocialSnapshot | null>`.
  - `export async function syncSocial(scope: string, conns: { meta?: Connection | null; linkedin?: Connection | null }, now?: Date): Promise<SocialSnapshot>`.
  - `const DAYS = 28`, `const MAX_POSTS = 30`, `export const SOCIAL_STALE_DAYS = 7`.
  - The LinkedIn part is a stub in this task. It rejects with `not_connected` and is skipped when `meta.liOrg` is
    missing; Task 8 fills it in.

Algorithm decisions the tests pin:
- **Part held.** Instagram is held when `isComposio(meta) && meta.data.instagram && meta.meta.igId`. LinkedIn is held
  when `isComposio(linkedin) && linkedin.meta.liOrg`. A part that is not held sets neither data nor error.
- **Media list.**
  - Follow `after` while the count is under 30 and the cursor is new; a repeated cursor stops the loop.
  - Read rows with `listOf(r)`, which also handles `data.data`.
  - `type` comes from `media_product_type === "REELS" ? "REELS" : media_type`.
- **Post results.**
  - Call `pmap(posts, read, 4)`.
  - On an error whose message matches `/ 401:|401: /`, rethrow.
  - On any other error, retry once with the fallback metrics.
  - A second failure leaves the post's numbers null.
  - Values are read per metric `name` from `listOf(r, "name")`, `values[0].value` or `total_value.value`, through
    `num`.
- **Account totals.** `GET_USER_INFO` uses `fields: "username,followers_count"`. `GET_USER_INSIGHTS` uses
  `metric: ["reach","views"], period: "day", metric_type: "total_value"`, with `since`/`until` as unix seconds over
  28 days. Use the argument names from Task 1.
- **`fromThakeen`.** One `db.smembers(SOCIAL_PUB_KEY(scope))` per sync.
- **Failure codes.**
  - `igError` is `"ig_not_professional"` when `GET_USER_INFO` fails with a non-401 error.
  - Otherwise use the `site-stats.ts` `errCode`-style code.
  - When every held part fails, throw the first failure.
  - When no part is held, throw `not_connected`.

- [ ] **Step 1: Write the failing tests.** Use `NOW = new Date("2026-10-08T09:00:00Z")`.
  - "keeps Instagram when LinkedIn fails, and throws only when every held part fails (662)":
    - `meta` is held and answers.
    - `linkedin` is held with `liOrg` set, and the Task 4 stub rejects.
    - Expect `snap.ig` defined, `snap.liError` set, and the call does not throw.
    - Then make Instagram fail too (`INSTAGRAM_GET_USER_INFO` fails with `"expired token"`). Expect a reject that
      matches `/401/`.
  - "a post whose insights fail twice keeps null numbers (663)": `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` always answers
    `{ successful: false, error: "metric not supported" }`. Expect `snap.ig.posts[0]` to equal
    `{ views: null, reach: null, likes: null, ... }`, and the media-insights tool to be called twice with the two
    metric sets.
  - "caps posts at 30, drops paging.next and foreign urls, stops on a repeated cursor (664)":
    - Two pages of 25 posts each carry `paging: { next: "https://graph.facebook.com/...access_token=SECRET", cursors: { after: "c1" } }`.
    - The second page repeats `after: "c1"`.
    - One post's permalink is `https://evil.example/p`.
    - Expect `posts.length === 30`, `JSON.stringify(snap)` does not contain `access_token`, that post's `url` is null,
      and no more than 2 calls to `INSTAGRAM_GET_IG_USER_MEDIA`.
  - "fromThakeen is per scope (665)": `sadd` `"m1"` under scope A. Sync scope B, whose media list contains `m1`.
    Expect `fromThakeen === false`. Sync scope A. Expect `true`.
  - "meta without Instagram is skipped, not failed": the Meta connection has no `data.instagram` and the LinkedIn
    part is held. Expect no `igError`.
  - "socialstats is wiped (667)": `db.set(SOCIAL_KEY(scope), {...})`, then `wipeAccount`, then
    `getSocialSnapshot === null`.
  - Captions: a 200-character caption with `<b>` comes back at 80 characters or fewer and without `<`.
- [ ] **Step 2:** Run them. Expect FAIL: `syncSocial is not a function`.
- [ ] **Step 3:** Implement as above. Write the snapshot with one `db.set`.
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Add `docs/system/architecture.md` (the `socialstats:{scope}` and `socialpub:{scope}` keys and the
  reader) and rows 662–665 and 667 to `tests.md`. Commit with
  `feat: read Instagram account and post results through Composio (rules 662-665, 667)`.

### Task 5: Daily sync and Dana's block (rules 666, 671)

**Files:**
- Modify: `src/lib/social-stats.ts`.
- Modify: `src/app/api/cron/daily/route.ts:108` (add the next line).
- Modify: `src/lib/stats.ts:172`.
- Test: `tests/composio-social.test.ts`.

**Interfaces:**
- Produces: `export async function syncSocialIfDue(scope: string, now?: Date): Promise<boolean>`.
- Produces: `export async function socialDataBlock(scope: string, now?: Date): Promise<string>`.

- [ ] **Step 1: Write the failing tests.**
  - "syncSocialIfDue (671)":
    - It returns false when the last snapshot is 19 hours old.
    - It returns false for a non-Composio `meta` record.
    - It returns true and writes when the snapshot is 21 hours old.
    - A refused token goes through `refusedToken` and marks `needsReconnect`. Mirror the existing `syncSiteIfDue`
      test in `tests/composio-reads.test.ts`.
    - It uses `getFreshConnection` for both providers.
  - "cron keeps going when the social read fails (671)": with `INSTAGRAM_GET_USER_INFO` failing, the daily route's
    output for the user contains `social_failed:`, and `site` or `ads` steps still run. Follow
    `tests/routes-admin-cron.test.ts`.
  - "socialDataBlock (666)":
    - It is `""` with no snapshot.
    - With `ig` only, it contains `<social_data>`, `"not available (unknown, not zero)"` for LinkedIn, and
      `never invent a change`.
    - A 9-day-old read adds the read-date line.
    - The block never contains a `"0"` that stands in for a null.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
  - **Due check:** read `getConnection(scope,"meta")`, `getConnection(scope,"linkedin")` and the snapshot with one
    `Promise.all`.
  - **Due condition:** at least one is Composio and not `needsReconnect`, and the snapshot is older than `DUE_MS`.
  - **Refused token:** on a throw, call `refusedToken(scope, <provider of the failing part>, e)`. Instagram failures
    map to `"meta"`.
  - **Cron:** add
    `try { if (await syncSocialIfDue(u.scope ?? u.email)) out.push("social"); } catch (e) { out.push(\`social_failed:${...}\`); }`
    after the `site` line.
  - **`socialDataBlock` lines:** the spec's lines verbatim, plus "followers are a count on the read date, not
    growth".
  - **Wiring:** add it to the `Promise.all` in `stats.ts:172` and join it after `site`.
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Add `docs/system/flows.md` (the daily social read) and rows 666 and 671. Commit with
  `feat: daily social read and Dana's social data block (rules 666, 671)`.

### Task 6: Reports page card (rule 668) and the Phase 1 Preview check

**Files:**
- Modify: `src/lib/report-sources.ts:15` (social providers gain `"meta"`).
- Modify: `src/lib/connectors/working.ts:22` (`export const READS_SOCIAL: readonly string[] = ["meta"]`, added to
  `READS_METRICS`).
- Modify: `src/app/[lang]/app/reports/page.tsx:32-37` (load `getSocialSnapshot`, pass `social`).
- Modify: `src/components/app/ReportsPanel.tsx:27,102,125-131`.
- Create: `src/components/app/SocialStats.tsx`.
- Modify: `src/lib/app-i18n.ts` (`reports` ar near line 282 and en near line 594).
- Test: `tests/connectors-working.test.ts:39`, `tests/composio-social.test.ts`.

**Interfaces:**
- Consumes: `SocialSnapshot` and `getSocialSnapshot`.
- Produces: `export function socialRead(s: SocialSnapshot | null): boolean`, which is `!!(s?.ig || s?.li)`, in
  `src/lib/report-sources.ts`. It is client-safe: a type-only import.

- [ ] **Step 1: Write the failing tests.**
  - Change `tests/connectors-working.test.ts:39` to `expect(reportSources(["meta"]).read).toEqual(["social"])` and
    keep its comment accurate.
  - Add "followers stays locked without a snapshot (668)": `socialRead(null) === false`,
    `socialRead({ at: "x" }) === false`, and `socialRead({ at: "x", ig: {...} }) === true`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
  - **Followers tile.** In `ReportsPanel`, the `followers` tile's `on` becomes
    `m.source === "social" ? socialRead(social) : sources.read.includes(m.source)`. Its link is `#social-stats` and
    its label is `R.inSocialCard`.
  - **`SocialStats({ lang, social })`.**
    - A card with `id="social-stats"`.
    - Instagram: `@user`, followers, 28-day reach and views.
    - The top 5 posts sorted by `views ?? -1`, then `reach ?? -1`. Each shows its date, type, caption, numbers
      (`—` for null), an `open` link (`rel="noopener noreferrer" target="_blank"`) when `url` is set, and
      `R.social.fromThakeen` when true.
    - When `igError === "ig_not_professional"`, show `R.social.notProfessional`.
  - **New strings (ar/en):**
    - `inSocialCard`: «في بطاقة السوشال» / "in the social card".
    - `social.title`: «نتائج السوشال» / "Social results".
    - `social.followers`: «المتابعون» / "Followers".
    - `social.reach28`: «الوصول (28 يوماً)» / "Reach (28 days)".
    - `social.views28`: «المشاهدات (28 يوماً)» / "Views (28 days)".
    - `social.topPosts`: «أفضل المنشورات» / "Top posts".
    - `social.fromThakeen`: «من ذكين» / "from Thakeen".
    - `social.open`: «افتح» / "Open".
    - `social.notProfessional`: «حساب إنستقرام ليس احترافياً، فلا نتائج له» / "This Instagram account is not a
      professional account, so it has no results".
    - `social.liNoPage`: «اربط صفحة شركة لترى نتائج لينكدإن» / "Connect a company page to see LinkedIn results".
    - `social.readOn`: «آخر قراءة» / "Last read".
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check` and `npx next build`. If the local build is blocked,
  note it and rely on the Vercel Preview build.
- [ ] **Step 5:** Add row 668 and a `docs/system/architecture.md` line for the card. Commit with
  `feat: social results card on the Reports page (rule 668)`, then push.
- [ ] **Step 6: Preview check, with the founder.** He connects Instagram on Preview, an admin triggers the daily cron
  for his account, and we read the Vercel logs.
  - Expect the output `social`, and on Reports, followers plus posts with numbers.
  - A tool-version error sends us back to Task 1 Step 2.
  - Report the measured answer shapes. If a `pick` path was wrong, fix it in this task with a test using the real
    shape.

## Phase 2 — LinkedIn page results

### Task 7: Gate — LinkedIn organization access, then list pages on connect and pick one (rule 669)

- [ ] **Step 0 (stop condition):** on Preview, with the founder's connected LinkedIn, run a one-off admin read of
  `LINKEDIN_GET_COMPANY_INFO` and then `LINKEDIN_GET_SHARE_STATS`. The simplest route is a temporary log line in
  `connectViaComposio` while he reconnects; remove it in the same task.
  - If either returns 403 or a permission error: **stop phases 2 and 3**. Report to the founder that this needs his
    own LinkedIn app with Community Management API approval. Do not continue.
  - Otherwise, record the real `COMPANY_INFO` row shape: the organization URN key, the role key, and whether a name
    is present.

**Files:**
- Modify: `src/lib/connectors/via-composio.ts:225-233` (connect).
- Modify: `src/lib/connectors/via-composio.ts:279` (add `selectOrgVia`).
- Modify: `src/app/api/connect/[provider]/route.ts:46-70`.
- Modify: `src/components/app/IntegrationsPanel.tsx:60-140`.
- Modify: `src/lib/app-i18n.ts` (`integrations`).
- Test: `tests/composio-social.test.ts`.

**Interfaces:**
- Produces: `meta.liOrgs` (JSON `{ urn: string; name: string }[]`, at most 20) and `meta.liOrg` (URN), on the
  linkedin connection.
- Produces: `export function selectOrgVia(c: Connection, org: string): Connection | null` in `via-composio.ts`.
- Produces: the route action `select_org`, gated by `"connectors"` in `ACTION_ROLE`, with body `{ action: "select_org", org }`.

- [ ] **Step 1: Write the failing tests (669).**
  - Connect with `LINKEDIN_GET_COMPANY_INFO` answering two ADMINISTRATOR rows, one ANALYST row and one malformed URN
    `urn:li:organization:12x`. Expect `liOrgs` to hold the two admin rows only and `liOrg` to be undefined, since
    there are two.
  - With one admin row, expect `liOrg` set.
  - With `COMPANY_INFO` failing as 403, the connect still succeeds and `liOrgs` is absent.
  - Route checks:
    - `select_org` with a URN not in `liOrgs` returns 400 `unknown_org`.
    - A member (non-admin) gets 403. Use the role helper from `tests/role-gates.test.ts`.
    - A stored URN returns 200 and saves `liOrg`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
  - **Connect.** After `GET_MY_INFO`, call `composioRead(scope,"linkedin","LINKEDIN_GET_COMPANY_INFO",{ start: 0, count: 50 }, accountId)`
    inside try/catch; a failure leaves the connect untouched.
  - **Filter.** Keep `^urn:li:organization:\d+$` with role `ADMINISTRATOR` or `CONTENT_ADMINISTRATOR`.
  - **Name.** Use the name from the row; when the row has none, use `Page {id}`.
  - **`selectOrgVia`.** Mirror `selectPageVia` and also set `liPostAs: "me"` (rule 670 relies on it).
  - **Panel.** Under the LinkedIn row, show a `<select>` of `liOrgs`, disabled unless `manage`, like the Meta page
    picker. Add the string `integrations.linkedinPage`: «صفحة الشركة التي نقرأ نتائجها» / "Company page we read
    results from".
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Add `docs/system/permissions.md` (`select_org` is connectors: owner or admin) and `flows.md`
  (connect lists pages), plus row 669. Commit with
  `feat: list LinkedIn company pages on connect and pick one (rule 669)`.

### Task 8: LinkedIn part of the read (completes rule 662)

**Files:**
- Modify: `src/lib/social-stats.ts`.
- Modify: `src/lib/connectors/working.ts` (`READS_SOCIAL = ["meta", "linkedin"]`).
- Modify: `src/components/app/SocialStats.tsx`.
- Test: `tests/composio-social.test.ts`, `tests/connectors-working.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - "keeps LinkedIn when Instagram fails (662)": expect `snap.li` and `snap.igError` both present, and no throw.
  - Sums: three DAY rows of `totalShareStatistics` with impressions 100, 50 and 0, clicks 5, 0 and 0, likes 3, 1 and
    0, comments 1, 0 and 0, shares 0, 1 and 0. Expect `impressions 150, clicks 5, reactions 4, comments 1, shares 1`
    and `engagement` = (5+4+1+1)/150, rounded to 4 decimals.
  - Zero impressions give `engagement: null`.
  - `LINKEDIN_GET_NETWORK_SIZE` answering `{ firstDegreeSize: 812 }` gives `followers: 812`. Its args are
    `{ organization_id: "<numeric id from liOrg>" }`.
  - `time_intervals` equals
    `(timeRange:(start:<ms 28 days before NOW>,end:<ms NOW>),timeGranularityType:DAY)`.
  - A 403-style error gives `liError === "li_no_page_access"`.
  - `reportSources(["linkedin"]).read` equals `["social"]`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. Sum the rows in code. Detect 403 with `/403|forbidden|access.?denied/i` on the error
  message. In `SocialStats`, add the LinkedIn block: page name, followers and the 28-day totals. Show
  `R.social.liNoPage` when the connection has no `liOrg` or when `liError === "li_no_page_access"`.
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check`.
- [ ] **Step 5:** Update row 662. Commit with `feat: read LinkedIn company page results (rule 662)`, then push.
  Preview check with the founder: his page's followers and totals appear on Reports.

## Phase 3 — Publish as the LinkedIn page

### Task 9: Post-as switch (rule 670)

**Files:**
- Modify: `src/lib/connectors/via-composio.ts:88-94` (`postToLinkedInVia`).
- Modify: `src/app/api/connect/[provider]/route.ts`.
- Modify: `src/lib/activity.ts:20-26` (add the kind `"connector_changed"`).
- Modify: `src/lib/app-i18n.ts` (activity `kinds` ar line 69 and en line 383, plus `integrations`).
- Modify: `src/components/app/IntegrationsPanel.tsx`.
- Test: `tests/composio-social.test.ts`.

**Interfaces:**
- Produces: `meta.liPostAs`, either `"me"` or `"org"`, absent meaning `"me"`.
- Produces: the route action `post_as`, gated by `"connectors"`, with body `{ action: "post_as", value: "me" | "org" }`.
- Produces: `export function postAsVia(c: Connection, value: string): Connection | null` in `via-composio.ts`.
- Produces: the activity row
  `{ kind: "connector_changed", by: byOf(u), via: "app", outcome: "linkedin:post_as:org" | "linkedin:post_as:me", note: <page name, cleaned> }`.

- [ ] **Step 1: Write the failing tests (670).**
  - `post_as` `"org"` without `liOrg` returns 400 `no_page`.
  - `post_as` with any value other than `me` or `org` returns 400.
  - A member gets 403.
  - With `liOrg` set: after `post_as: "org"`, publishing a test task sends `LINKEDIN_CREATE_LINKED_IN_POST` with
    `author === liOrg`. After `post_as: "me"`, `author === meta.author`.
  - `select_org` to another page resets `liPostAs` to `"me"`.
  - Re-connecting LinkedIn through `connectViaComposio` leaves `liPostAs` absent, and the next post goes as the person.
  - One `connector_changed` activity row is written per `post_as` change.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
  - **Author.** `author = c.meta?.liPostAs === "org" && c.meta?.liOrg ? c.meta.liOrg : c.meta?.author`. Keep the
    existing `linkedin_no_author` throw when it is empty.
  - **Labels.** The activity kind label is ar «تغيّر إعداد ربط» / en "Connection setting changed".
  - **Panel.** A two-option control "Post as: me / {page}" is shown only when `liOrg` is set and disabled unless
    `manage`. Strings `integrations.postAs` «انشر باسم» / "Post as" and `integrations.postAsMe` «حسابي» / "My
    profile".
- [ ] **Step 4:** Run them. Expect PASS. Then `npm run check` and `npx next build`.
- [ ] **Step 5:** Add `docs/system/permissions.md` (`post_as` is connectors) and `flows.md` (post as page), plus row
  670. Commit with `feat: owner can publish to LinkedIn as the company page (rule 670)`, then push.
- [ ] **Step 6: Preview check, with the founder's explicit approval for one live test post.** He switches to the page
  and approves a test item. It must appear on the page. He then switches back, and the next post goes as him.
