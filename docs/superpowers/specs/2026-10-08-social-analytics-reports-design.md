# Social platform analytics in the agents' reports (design, 2026-10-08)

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** merged as #300 (2026-10-09, in `production`); dormant until the `COMPOSIO_*` variables are set.

Branch `claude/social-analytics-reports` (cut from `main` at d1a8f3f, after PR #281). Rules 730-749, flows §50,
permissions route rows from 154 (agreed with the staging and Paymob sessions on 2026-10-08). Builds on
`2026-10-08-social-results-via-composio-design.md` (the Instagram and LinkedIn readers).

Revision 2 (same day): every claim below was checked against the code on this branch and against Composio's tool schemas
(`composio tools info`, read 2026-10-08) and X's API docs. Line numbers are on this branch at d1a8f3f.

## 1. What the founder asked and decided

Request, verbatim: "I meant the social platform analytics tools.. so the agent uses them to do analytics reports.. that
means meta, google, x , linkeding, tiktok, sapchat.. and more".

Decisions on 2026-10-08 (AskUserQuestion):

- Build order: **A + B + C together** (sections 4, 5 and 6), one branch, phased commits.
- Report shape: **Dana's existing reports** carry the analytics (weekly report, board deck, dashboard spec, and Majed's
  strategy review). No new task type and no new price.
- X: **the owner pays in credits**, on a click. Nothing reads X on a schedule.
- The founder starts these applications now (section 9): Meta `ads_read` review, TikTok stats scopes, a Snap Marketing
  API app and a LinkedIn Advertising API app, and the Google Business Profile access form.

## 2. What exists on `main`

| Platform | Today | Path | Who reads it |
|---|---|---|---|
| Instagram | 28-day reach and views, followers, up to 30 posts | Composio managed (`social-stats.ts` `readIg`) | `<social_data>` in `statsFor` |
| LinkedIn page | 28-day share totals and followers, no posts | Composio managed (`readLi`) | `<social_data>` |
| GA4 | 28 days by channel, top landing pages; first property only | Composio managed (`site-stats.ts`) | `<site_data>` |
| Search Console | clicks, impressions, position, top queries; first site only | Composio managed | `<site_data>` |
| Meta Ads | ad-level 30 days | native `ads_read` or Composio with our app | `perfimport:{scope}` (Reports card) and `performance-learnings.md` (every agent's memory through `CORE_FILES`, latest platform only, findings without totals); not in `statsFor` |
| Snapchat Ads | per-ad 30 days | native or Composio with our app | same |
| Google Ads | constant GAQL, 30 days | Composio managed | same |
| TikTok Ads | integrated report, 30 days | Composio managed | same |
| Facebook Page, YouTube, X, TikTok organic, LinkedIn Ads, Snapchat organic, Google Business Profile | not read | | |

Quality gaps, all on `main`:

1. Ad results never reach `statsFor`. Each ad sync and each CSV upload overwrites `perfimport:{scope}` and
   `performance-learnings.md` (`perf-store.ts:20-21, 36`; `performance/route.ts:38`), so one platform erases another.
   The daily cron reads one ad platform per day (`syncAdsIfDue`, `perf-store.ts:41-48`), so with N platforms each row is
   up to N days old. The owner's `sync_ads` click has role `read` and no rate limit (`connect/[provider]/route.ts:49, 107`).
2. `statsText(k, { store? })` (`stats.ts:149`) says traffic and ad spend are NOT in the data in both branches, even when
   `<site_data>` is attached; the no-store branch also says sales are absent.
3. No reader has a previous period, so a report cannot say "up" or "down" honestly.
4. GA4 and Search Console keep the first property and site; the others are stored in `meta.gaProperties` (JSON
   `{id,name}[]`) and `meta.gscSites` (JSON `string[]`), each only when there are 2 or more (`via-composio.ts:290-304`),
   with no way to choose.
5. Site metrics store a missing value as 0 (`site-stats.ts:44, 74-82`), not null.
6. On the live site every reader is dormant: production has no `COMPOSIO_*` variables, and the Hostinger daily cron was
   not created at last check.

## 3. Principles (project rules, restated for this feature)

- Read only. The Composio catalog gains read slugs only; no write slug is added to any toolkit, and a new toolkit gets
  `write: {}`. The ad and analytics toolkits do list write tools on Composio's side (for example
  `METAADS_COPY_AD_OBJECT`, `GOOGLE_SEARCH_CONSOLE_ADD_SITE`); only our allowlist keeps them read-only, and the catalog
  header (`composio-catalog.ts:7-10`) is corrected to say so.
- Connector data is untrusted. Names, captions and ad copy pass through `clean(s, 80)` and reach the model only inside a
  labelled data block through `asData`. On the Reports page they are React text nodes, never markup.
- Tenant scope from `sc(u)` for every key. Account, page, channel, property and ad-account ids come only from the stored
  connection's connect-time listing, never from the request.
- `null` means "not read", never zero, for social, site and ad figures.
- No `await db.*` in a loop: one get and one set per snapshot, `Promise.all` across keys.
- Credits are charged in code before any paid read (X), never on the model's say-so.
- Reports say plainly which platforms are not read. The list comes from code, never from the model.
- No invented numbers: a change ("up 12%") is written only where the previous period was read; otherwise `[رقم]` and
  "needs a second read".
- Composio pins: every toolkit is pinned to the `version` that `composio tools info <slug>` reported when its allowlisted
  args were checked. The `latest_version` field of `composio dev toolkits version` is stale and is not used. New pins
  (read 2026-10-08): facebook 20261008_00, youtube 20261008_00, linkedin 20260924_00, tiktok 20260917_00, snapchat
  20260918_00, linkedin_ads 20260826_00. Every arg already allowlisted for these toolkits exists at those versions. In
  @composio/core 0.22.0 `execute` fetches the tool at the pinned version first and throws `ComposioToolNotFoundError`
  before any platform call when it is missing, so the B0 probe runs on these pins.
- Readers that call Composio import `@/lib/connectors/composio`. The rule-652 importer regex in `tests/composio.test.ts`
  widens to `/from "[^"]*\/(?:composio|via-composio)"/` (it matches today's 10 files exactly), so a relative import
  cannot slip past, and each new reader file joins the expected list.

## 4. Phase A: one real cross-platform report from the eight readers we have

A1. **Ad totals per platform.** `syncAds` keeps writing `perfimport:{scope}` and `performance-learnings.md` and, in the
existing `Promise.all` at `perf-store.ts:36`, writes `adstats:{scope}:{provider}`, built from `pull` (never from the
PerfSnapshot, which drops null keys and keeps 3 ranked rows):

```ts
type AdTotals = { spend: N; impressions: N; clicks: N; conversions: N; revenue: N };
type AdStats = AdTotals & {
  provider: AdProvider | "csv"; account: string; currency: string | null;
  range: { from: string; to: string } | null;          // a CSV may have no range
  prev?: AdTotals & { range: { from: string; to: string } };
  top: { name: string; spend: N; clicks: N; conversions: N }[];   // <= 10 by spend
  at: string;
};
```

`top[].name = clean(row.name, 80)` and `account = clean(pull.account, 80)`. A total is the sum over rows that carry it;
no row carrying it gives null. The CSV path: the upload route (`performance/route.ts:36-38`) builds
`adStatsFrom("csv", { rows, range, platform, account: file }, null, now)` from `readRows`' rows and writes
`adstats:{scope}:csv` next to `savePerf` in one `Promise.all`. `savePerf` itself never writes `adstats`. DELETE
`/api/performance` also deletes `adstats:{scope}:csv`. `adsync:{scope}:{p}` stays a timestamp because `routines.ts`
reads it. `adDataBlock(scope)` reads every ad provider plus `csv` in one `Promise.all` and returns `<ad_data>` through
`asData`, printing each row's `at`. `wipeAccount` deletes `adstats:{scope}:{p}` for every `AD_PROVIDERS` entry and `csv`.

A2. **Previous period**, read by the same reader in the same run, only from ranges the platform returns:

- Instagram: a second `INSTAGRAM_GET_USER_INSIGHTS` for the 28 days before the window (`since`/`until` already
  allowlisted; both windows stay inside Instagram's 90 days).
- LinkedIn page: 56 days of DAY share statistics in the one allowlisted `time_intervals` call, split in code.
- Every social reader (Instagram, Facebook, LinkedIn, YouTube): an earlier period in which no figure was read, or every
  figure read is 0, gives no `prev`, so no "up from 0" is written (amended 2026-10-08, phase B review).
- GA4: both reports send `dateRanges: [{ startDate, endDate, name: "cur" }, { startDate: prevFrom, endDate: prevTo,
  name: "prev" }]`; GA appends a `dateRange` dimension carrying these names and code splits rows by it. The channel
  report asks for up to 40 rows across both ranges. The landing-page report sends `orderBys: [{ desc: false, dimension:
  { dimensionName: "dateRange" } }, { desc: true, metric: { metricName: "sessions" } }]` with limit 20, so the window's
  rows come first and a busy previous range cannot crowd them out, and the window's top 10 are kept. The landing-page
  report has its own catch: its failure gives `pages: []`, keeps the totals and `prev`, and logs `ga_pages_failed` once
  with the code alone (amended 2026-10-08, phase B review).
- Search Console: one more `SEARCH_ANALYTICS_QUERY` by date for the previous range.
- Ads (Meta native and Composio, Snapchat native, Google Ads, TikTok Ads, LinkedIn Ads): the same reader called a second
  time for the 30 days before the window, with the same constant queries and date checks; for LinkedIn Ads that is the
  same constant analytics call over the previous 30 days, `totalsOnly` skipping the campaign-names call (amended 2026-10-09, whole-phase review). A failed
  second read leaves no `prev`; it never fails the sync.
- Snapchat Ads through Composio: `SNAPCHAT_GET_AD_ACCOUNTS_STATS` with `{ ad_account_id, fields: "spend", granularity:
  "TOTAL", start_time, end_time }` gives `prev.spend` only (Snap serves only spend at the account level); the other
  `prev` figures stay null. A second per-ad pass is not run (up to 50 more calls).

A3. **Property and site choice.** `select_property` runs only on `/api/connect/google` with `isComposio(c)`, role
`connectors`. GA4: `id` must equal an `id` in `JSON.parse(meta.gaProperties)`; it writes `meta.gaProperty` and
`meta.gaName`. GSC: `id` must be in `JSON.parse(meta.gscSites)`; it writes `meta.gscSite`. `meta.account` is rebuilt as
at `via-composio.ts:305`. Then a new `readSiteSoon(scope)` (an `after()` running `syncSiteIfDue(scope, new Date(), true)`,
with a `force` parameter added to `syncSiteIfDue`). The forced read runs only when `allow(\`sitesync:${scope}\`, 6, 3600)`
grants it, so a choice draws on the six site reads an hour; the answer is `{ ok, account, read }`, and with `read: false`
the next daily run or refresh reads the new choice (amended 2026-10-08, phase B review).

A4. **Owner refresh.** `sync_site` on `/api/connect/google`. `sync_social` is accepted on any held social provider path
(meta, linkedin, youtube, tiktok) and calls `syncSocialIfDue(sc(u), new Date(), true)`, which reads every held part.
Limits: `allow(\`socialsync:${sc(u)}\`, 6, 3600)` and `allow(\`sitesync:${sc(u)}\`, 6, 3600)`, keyed by scope so team
members share them; on false, `retryLater({ ok: false, error: "slow_down" }, 3600)`. Both are `"read"` in `ACTION_ROLE`,
free, and both set `ownersync:{scope}` (A7). The daily cron keeps refreshing every 20 h. `sync_ads` and `sync_x` have
the same six an hour per workspace (`adrefresh:{scope}`, every ad platform together, and `xsync:{scope}`, before X's
charge), so no member's clicks can spend a platform's own limits (amended 2026-10-09, whole-phase review).

Social answers and first reads (amended 2026-10-08, phase B review):

- A social read that saved the snapshot while a part's token was refused (`PartlyRead`) answers 200 `{ ok: true, read:
  true, reconnect: "<provider>" }` only when at least one part was actually read; when no part was read, it answers 502
  `reconnect_required`: with only known states beside the refused part, the snapshot is written with those states and
  the refused part's error; when the other parts failed, nothing is written and the last snapshot stands. "Actually
  read" is the Not-read list's own test (`nothingRead`, exported from social-stats.ts): a part with a follower count or
  a total. A part with neither, such as a Facebook Page whose posts were read but not its insights, is written but is no
  read, so beside a refused token the answer is still 502 (amended 2026-10-09, whole-phase review).
- The record of every part whose token was refused is marked for reconnect (`SocialReadError.refusedBy`), and only
  those. Only the adapter's 401 is a refused token: a 403 such as `quotaExceeded`, or any other failure, is answered 502
  with its message and marks nothing.
- Every Composio social connect (the callback) starts a first read (`readSocialSoon`). `select_page` on a Composio Meta
  record reads the new Page only when `allow(\`socialsync:${scope}\`, 6, 3600)` grants it and answers `{ ok, account,
  read }`. `select_org` on a Composio LinkedIn record does the same under the same bucket and answers `{ ok, account,
  read }`; the Integrations page says "Page saved. Its results come with the next read." when `read` is false (amended 2026-10-09, whole-phase review).

A5. **Prompts.** `statsText(k, { store?, site?, social?, ads? })`: traffic is said absent only without `<site_data>`, ad
spend only without `<ad_data>`. `statsFor` sets each flag from a non-empty block and appends `adDataBlock(scope)` and the
Not-read block in the same `Promise.all`. `SPECS` in `noor.ts` (weekly_report 46, board_deck 47, strategy_review 48,
dashboard_spec 55) name WORKSPACE, STORE, SITE, SOCIAL and AD DATA, compare only where `prev` exists, and list the
Not-read platforms (A6); editing `SPECS` is what moves `codeHash` (`prompt-stamp.ts:30-31`). Ad totals come only from
`<ad_data>`; `performance-learnings.md` gives findings for the latest platform and is never the source of a total. The
golden set gains a `dana-board-deck` case; its STATS fixture gains `<site_data>`, `<social_data>` (with and without
`prev`) and `<ad_data>`; `GOLDEN_VERSION` goes to 6; then `runGolden("manual", { agent: "dana" })` and
`{ agent: "majed" }` on Preview.

A6. **Not read, said in code.** `notRead(scope)` returns `{ platform, reason }[]` for the founder-named platforms with no
read result for this workspace, from the connection records, the snapshots and the registry. `notReadBlock(items)`
renders it for the model: "list exactly these platforms as not read, in the report's language, with their reason; never
add or drop one". The Reports card renders the same items from its own strings. Reasons: `not_connected`, `reconnect`,
`choose_page`, `refresh_x` (X, 1 credit), `x_direct_only`, `read_failed`, `analytics_scope` (YouTube public counts only),
`closed_to_apps` (Snapchat organic), `waiting_approval` (Google Business Profile), and `publish_only` (amended
2026-10-09, whole-phase review: a record that publishes to the platform but that no reader reads, such as a direct Meta
record's chosen Page and the Instagram account linked to it, is "connected for publishing only", never "not connected"). The Reports page builds
the list with `notReadOf` over the reads it already holds for its cards, so each key is read once.

A7. **Dana's routine gate is not widened.** The gate `activity` (`routines.ts:48-53`, used only by
`dana_weekly_report`) reads neither `sitestats` nor `socialstats`, so cron site and social syncs already do not count.
An owner `sync_site` or `sync_social` click sets `ownersync:{scope}` to the ISO time (TTL 8 days; `wipeAccount` deletes
it), and the gate reads it in the same `Promise.all`. Cron store and ad syncs keep counting as they do today (section 11).

A8. **Snapshot v2.** The social snapshot moves to one shape per platform (section 7). A snapshot without `v: 2` is due
(`!snap || snap.v !== 2`) and read again, never migrated in place. Every v1 reader moves in the same commit:
`socialDataBlock`, `socialRead` and `connectedSources` (`report-sources.ts`; a Meta record also counts with `pageId`),
`READS_SOCIAL` (`connectors/working.ts:23`; youtube, tiktok and x join), `SocialStats.tsx`, and the due check.

## 5. Phase B: new platforms Composio reads with managed auth

B0. **Probe on Preview, before the PR leaves draft.** With the founder's own Page, channel and company page, on the new
pins: `FACEBOOK_GET_PAGE_INSIGHTS`, `FACEBOOK_GET_PAGE_POSTS`, `FACEBOOK_GET_POST_INSIGHTS`, `YOUTUBE_LIST_CHANNELS`
(statistics), `YOUTUBE_QUERY_ANALYTICS` and `LINKEDIN_GET_ORG_PAGE_STATS`. Record any `ComposioToolNotFoundError`, every
real output shape (schemas are envelope-only), which metrics return data, and whether the managed apps hold
`read_insights`, `yt-analytics.readonly` and `rw_organization_admin`. Preview `APP_ORIGIN` is scoped to the Composio
branch today, so the founder scopes it to this branch first. Readers parse tolerantly so a shape surprise leaves nulls.

B1. **Facebook Page** on the existing `facebook` toolkit, page id from `meta.pageId` (the publishing choice). The id is
1 to 30 digits (`PAGE_ID`, facebook.ts), checked where the reader holds the record, where it reads, in the Not-read
list and in the Page list at connect; the account falls back to `Page {id}` through `clean`, cut to 80 (amended 2026-10-09, whole-phase review):

- `FACEBOOK_GET_PAGE_INSIGHTS: ["page_id","metrics","period","since","until"]`, constant `metrics:
  "page_media_view,page_total_media_view_unique,page_post_engagements,page_total_actions,page_follows,page_daily_follows_unique,page_daily_unfollows_unique"`,
  `period: "day"`, 56 days in one call (Meta allows 90), split in code for `prev`. Mapping: views = page_media_view,
  reach = page_total_media_view_unique, engagements = page_post_engagements, clicks = page_total_actions,
  followsGained/followsLost = sums of the daily follows and unfollows, followers = the last page_follows value. An empty
  `{}` is null. Followers come only from rows dated with their day (YYYY-MM-DD); an undated row counts for no day
  (amended 2026-10-08, phase B review).
- `FACEBOOK_GET_PAGE_POSTS: ["page_id","fields","limit"]`, constant `fields:
  "id,message,created_time,permalink_url,status_type,from,shares,reactions.summary(true),comments.summary(true)"`,
  `limit` 30. The feed also returns visitor and tagged posts and its `since`/`until` filter the updated time, so code
  keeps only posts whose `from.id` equals the page id and whose `created_time` is inside the window.
- `FACEBOOK_GET_POST_INSIGHTS: ["post_id","metrics","period"]`, constant `metrics:
  "post_media_view,post_total_media_view_unique"` (the only two Meta still serves); likes, comments and shares come
  from the post fields.
- `fields` never includes `access_token`. Post links only on `facebook.com`/`www.facebook.com`.
- Fallback if the managed app has no `read_insights`: the existing Meta app (`META_APP_ID`) after its App Review
  (section 9); until then `errors.facebook` holds a known code and the Not-read line names it. Graph's permission codes
  `(#10)` and `(#200)` on the insights call are the same known `fb_no_insights` (amended 2026-10-08, phase B review).

B2. **YouTube channel.** Counts from the already-allowlisted `YOUTUBE_LIST_CHANNELS { part: "statistics", mine: true,
maxResults: 1 }` (followers = subscriberCount). Allowlist `YOUTUBE_QUERY_ANALYTICS:
["ids","startDate","endDate","metrics","dimensions"]` with `ids: "channel==MINE"`, constant `metrics:
"views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost"`, `dimensions: "day"`, 56 days
checked against `^\d{4}-\d{2}-\d{2}$`, split in code for `prev`. Posts: `YOUTUBE_LIST_CHANNEL_VIDEOS
["mine","part","maxResults"]` then `YOUTUBE_GET_VIDEO_DETAILS_BATCH ["id","parts"]` (≤ 30 ids). A refused analytics
call keeps the public counts and sets the known `yt_no_analytics`. Links only on `youtube.com`/`www.youtube.com`.
A channel id is `^UC[\w-]{10,40}$` everywhere it is checked (the reader, the connect and the read sources); the account
name falls back to `clean(\`Channel ${channelId}\`, 80)`. A `LIST_CHANNELS` answer with rows none of which is the stored
channel is a failed read (`yt_other_channel`), not a known state (amended 2026-10-08, phase B review).

B3. **LinkedIn page views.** Allowlist `LINKEDIN_GET_ORG_PAGE_STATS:
["organization","timeRangeStart","timeRangeEnd","timeGranularityType"]` with `organization: meta.liOrg` (the URN, checked
against `^urn:li:organization:\d+$`) and `timeGranularityType: "DAY"` over 56 days, split like the share statistics.
It needs `rw_organization_admin` with the ADMINISTRATOR role; a 403 keeps the rest of the LinkedIn part and leaves
`pageViews` null. A page-stats call stopped by the deadline does the same and sets no `errors.linkedin` (amended
2026-10-08, phase B review).

B4. **One deadline.** All social readers run in `Promise.allSettled` under one deadline, 30 s from the start of
`syncSocial`, replacing Instagram's `POSTS_BUDGET_MS` (25 s, `social-stats.ts:31, 119`); LinkedIn has none today. Each
reader checks `Date.now() < deadline` before every `composioRead` (a reader started past the deadline rejects with
`deadline` and makes no call; amended 2026-10-08, phase B review); a call in flight can still take `CALL_TIMEOUT_MS`
(20 s), so one user's worst case is 30 + 20 s. The daily cron's `START_BUDGET_MS` is 240 000 ms minus the first-hop
sweep (`daily/route.ts:143, 183`), and social runs last, after the brief.

## 6. Phase C: platforms that need our own apps or credits

C1. **TikTok organic.** Pin tiktok to 20260917_00. Allowlist `TIKTOK_GET_USER_STATS: ["fields"]` (constant
`["follower_count","likes_count","video_count"]`) and `TIKTOK_LIST_VIDEOS: ["max_count","cursor"]` (max_count 20, at most
2 pages for 30 posts). Composio with our own TikTok app (no managed auth); needs `user.info.stats` and `video.list`
approved on our app and added to the Composio auth config (section 9), and owners connect again. Only public videos are
listed, so an account with no public posts shows none; that is not a failure. Counters are lifetime; changes come from
history (section 7): Dana's block gives a part `last_month`, the followers at the last read of an earlier month, and a
change in followers may be given against it, never a change in totals (amended 2026-10-09). Links only on
`tiktok.com`/`www.tiktok.com`. A scope refusal (`scope_not_authorized`,
`scope_permission_missed`, or an insufficient or missing scope: one pattern, `SCOPE_REFUSED`, for the adapter and the
reader) keeps that code through the adapter's catch, so it is never a reconnect. When both calls
fail, the read is the known `tt_no_scope` only when both were scope refusals, else it fails with the other call's error
(amended 2026-10-08, phase B review).

C2. **LinkedIn Ads.** New provider `linkedin_ads`, Composio only, our own LinkedIn app with the Advertising API product.
Touch points: the `Toolkit` union; `TOOLKITS.linkedin_ads = { provider: "linkedin_ads", authEnv:
"COMPOSIO_AUTH_LINKEDIN_ADS", read: { LINKEDIN_ADS_SEARCH_AD_ACCOUNTS: ["status","test","page_size","page_token"],
LINKEDIN_ADS_GET_AD_ACCOUNT: ["ad_account_id"], LINKEDIN_ADS_GET_AD_ANALYTICS:
["q","pivot","fields","accounts","dateRange","timeGranularity"], LINKEDIN_ADS_SEARCH_CAMPAIGNS:
["adAccountId","pageSize","pageToken"] }, write: {} }`; `TOOLKIT_VERSION.linkedin_ads = "20260826_00"`;
`PROVIDER_TOOLKITS.linkedin_ads`; the registry entry and `COMPOSIO_ONLY`; `AD_PROVIDERS`; `PerfSnapshot.source`; an
`adRowsVia` branch; the connect-time `adAccounts` listing and `select_ad_account`; `READS_ADS` and the `ads` source in
`report-sources.ts`; variables.md `COMPOSIO_AUTH_LINKEDIN_ADS`. Analytics call (constant): `q: "analytics"`, `pivot:
"CAMPAIGN"`, `timeGranularity: "ALL"`, `accounts: ["urn:li:sponsoredAccount:<id>"]`, `dateRange: { start: {year, month,
day}, end: {...} }`, `fields:
"impressions,clicks,costInLocalCurrency,landingPageClicks,externalWebsiteConversions,pivotValues,dateRange"`. Campaign
names come from `SEARCH_CAMPAIGNS`. The id is an integer for `GET_AD_ACCOUNT` and `SEARCH_CAMPAIGNS` and a URN in
`GET_AD_ANALYTICS`. `prev` is the same call over the previous range.

C3. **X, owner pays.** No scheduled read. On the Reports page, "Refresh X (1 credit)" posts `{ action: "sync_x" }` to
`/api/connect/x`:

- `ACTION_ROLE.sync_x = "generate"` (any member; permissions.md says it spends 1 credit of the account, charged to
  `u.email`, the account record, also for members). Order: (1) `getFreshConnection` (already first); (2) `isComposio(c)`
  answers 409 `x_direct_only`, before any charge; (3) if `xstats:{scope}` is dated today (UTC), return it with no
  charge and no X call; (4) `trialOver(u)` answers 402 `trial_over`; (5) `renewalDue(u)` runs `renewIfDue(u.email)`; (6)
  `chargeOnce(u.email, X_READ_CREDITS, { scope: sc(u), agent: "dana", cap: (await getGov(sc(u))).agentCaps.dana },
  \`xread:${sc(u)}:${utcDay}\`)`: `agent_cap` answers 402 with spent and cap, `no_credits` 402 with need and credits,
  `reused: true` reads with no new debit; (7) `readX`; (8) save.
- On any failure (401, 402, 403, 429, 5xx, timeout, malformed body) `refundOnce` runs only if no X part dated today
  exists after the failure, and only in the click that took the charge (`reused: false`); a click that read on the
  hold never refunds. A click on the hold whose read is saved calls `chargeOnce` again on the same claim: a no-op while
  the hold stands, one debit when the charging click failed first and gave the credit back, so one credit stands for
  the day's read in either order; a refused re-charge (no credits, Dana's cap) leaves that read free, and so does a
  read that lands in the moment between the charging click's check and its refund. A click stopped with no catch run
  leaves its hold, and the credit stands (amended 2026-10-09, whole-phase review). A read with zero posts is a success: it saves followers with `posts: []`
  and keeps the charge (X billed the user read). The hold lives on `User.paidOnce` for 8 days; no sweep covers `xread:`.
- `readX(c, now)` is new in x.ts (`xMe` has no fields and no timeout and is not reused). Two GETs, each with
  `AbortSignal.timeout(15_000)`: `/2/users/me?user.fields=public_metrics`, then
  `/2/users/{id}/tweets?max_results=10&start_time=<now − 30 d, RFC3339 without ms>&exclude=retweets&tweet.fields=created_at,public_metrics,non_public_metrics,organic_metrics`.
  The id must match `^[0-9]{1,19}$`. One page only: `pagination_token` and `expansions` are never sent. Parsed
  tolerantly: shares = repost_count ?? retweet_count, posts = post_count ?? tweet_count, a missing number is null.
  The field names are confirmed with one real call on Preview before the PR leaves draft.
- Errors: 401 only for HTTP 401 (`x 401: …`), so `refusedToken` asks for a reconnect. A 402, 403 or 429 throws
  `x_unavailable`, a message with no 401 or 403 digits, so `refusedToken` leaves the connection alone; a 429 is answered
  with 429 and X's Retry-After (rule 680).
- Cost: constants `X_READ_CREDITS = 1`, `X_MAX_POSTS = 10`, `X_READ_USD = { user: 0.010, post: 0.005 }` (X list prices
  on 2026-10-08, a row in `docs/system/costs.md`): $0.060 per refresh, under `maxCostPerCreditUsd()` ≈ $0.07104 and the
  VAT-inclusive ≈ $0.0618. X deduplicates within a UTC day and bills only responses that return data.
- Stored in its own key `xstats:{scope}` = `PlatformPart & { at; history? }`, one get and one set. `syncSocial` never
  reads or writes it, so a cron social sync never erases it and X's date never postpones Instagram's. `socialDataBlock`
  and the card merge it at read time with its own date. `wipeAccount` deletes it, and so does disconnecting X
  (`DELETE /api/connect/x`, amended 2026-10-09), so another account never shows this one's read or history. A refresh
  is six clicks an hour per workspace at most (`xsync:{scope}`, before any charge), and a refund that fails is logged
  and never hides X's own answer.
- When the X record is Composio-routed, X is never read and never charged; the Not-read line says X needs the direct
  connection.

C4. **Meta Ads and Snapchat Ads go live** with no new code once the Meta review passes and our Snap app exists
(section 9).

## 7. Shapes

```ts
type N = number | null; // null = not read
type Platform = "instagram" | "facebook" | "linkedin" | "youtube" | "tiktok";
type Totals = { views: N; reach: N; engagements: N; clicks: N; likes: N; comments: N; shares: N; pageViews: N; followsGained: N; followsLost: N; watchMinutes: N };
type SocialPost = { id: string; date: string; type: string; caption: string; url: string | null; views: N; reach: N; likes: N; comments: N; shares: N; saved: N; fromThakeen: boolean };
type PlatformPart = {
  platform: Platform | "x";
  account: string;                                  // clean(), 80
  range: { from: string; to: string };
  followers: N;
  totals: Totals;
  prev?: { range: { from: string; to: string }; totals: Totals };
  posts: SocialPost[];                              // <= 30
  accountId?: string;                               // stored connection's id only, never shown or sent to the model
};
type HistoryRow = { month: string; platform: Platform | "x"; followers: N; totals: Totals };
type SocialSnapshot = {
  v: 2; at: string;
  parts: Partial<Record<Platform, PlatformPart>>;
  errors: Partial<Record<Platform, string>>;        // a failed read, or a known state beside a partial part
  history: HistoryRow[];                            // <= 13 per platform
};
type XStats = PlatformPart & { platform: "x"; at: string; history: HistoryRow[] };
```

History: each sync upserts one row per read platform for the read's UTC month (the last read of a month wins) and keeps
the newest 13 per platform. It covers the platforms' short windows (Instagram 90 days, TikTok lifetime counters, X 30
days for private metrics). It lives in the same object, is written in the same set, and is deleted with the account.
A part read from another account than the stored part's (both names read and different) starts that platform's rows
again, so a change is never worked out across two accounts (review of Task 8, 2026-10-08). A part carries the optional
`accountId` taken only from the stored connection (Instagram `meta.igId`, Facebook `meta.pageId`, LinkedIn `meta.liOrg`,
YouTube `meta.channelId`; TikTok has none). When both parts carry one, the ids decide: history is dropped only when they
differ, so a renamed account keeps its rows; otherwise the name rule stands. This is the expand step (rule 679): old
parts without the id still follow names. `accountId` never reaches the model or the page (`socialForPage` strips it)
(amended 2026-10-08, phase B review). X's read carries the user id X answered on `/2/users/me` for the owner's own
token (checked against `^[0-9]{1,19}$`, the id the posts are read under), not an id stored at connect, so records
connected before this change are covered too; `refreshX` applies the same rule to `xstats:{scope}` (ids decide when
both reads carry one, else the handles), and `xForPage` strips the id from the `sync_x` answer and the Reports page.
X's handle keeps its own characters (`handle`: letters, digits, `_` and `.`, at most 80), and so does an Instagram
username (amended 2026-10-09, whole-phase review). The history is read back: SOCIAL DATA gives each part whose followers
were read `last_month` (`{ month, followers }`), its platform's newest row of an earlier UTC month (X's from its own
history), only when that row's followers is above 0; a change in followers may be given against it, never a change in
totals (amended 2026-10-09).

`fromThakeen` is true only for ids in `socialpub:{scope}`. `publish-once.ts:126` is widened to add the post id for
facebook, linkedin, youtube, tiktok and x; until a platform's ids land, its posts carry `fromThakeen: false`.

Readers: a `READERS` map in `social-stats.ts`, `platform → { provider, holds(c), read(scope, c, now, deadline) }`. New
Composio readers live in `src/lib/social-read/{facebook,youtube,tiktok}.ts`; X reads in `x.ts`.

## 8. Reports page

The SocialStats card shows one row per part (X merged from `xstats`) with its previous-period change where `prev`
exists, the Not-read list, a "Refresh" button (`sync_social`, free, any member), and for X "Refresh X (1 credit)". The
footer says "Refreshed daily" without X, and "Refreshed daily; X only when someone presses Refresh X" when X's row or
button is shown (amended 2026-10-09, whole-phase review). GA4 and
Search Console get a property selector when more than one is stored (owner and admin). The page shows no model text.
Captions, names, account labels and the Not-read items render as React text nodes (never `render`, never
`dangerouslySetInnerHTML`), as SocialStats.tsx does today. Post links are kept only on each platform's fixed host and
open with `rel="noopener noreferrer"`.

## 9. What the founder does (calendar time; started 2026-10-08)

1. **Meta, `ads_read`.** In the Meta app behind `META_APP_ID`: App Review → Permissions and Features → request Advanced
   Access for `ads_read` (and `read_insights`, `pages_read_engagement`, `instagram_manage_insights` as the fallback for
   section 5). Business Verification must be complete first (Business Settings → Security Center). Each permission
   needs a screencast of its use in Thakeen and a written use case; the full Marketing API tier also needs 500 calls in
   15 days with under 15% errors, which comes from real use after approval.
2. **TikTok stats scopes.** In the TikTok developer portal for our app: add `user.info.stats` and `video.list`, then
   submit for review (2 to 3 business days; a website, privacy policy and a demo video are asked). Then add the two
   scopes to the Composio auth config named by `COMPOSIO_AUTH_TIKTOK`. Since 20 Mar 2026 the Accounts API Access
   Application Form is required before a scope increase that touches TikTok Accounts; file it now if full insights are
   wanted later.
3. **Snap Marketing API app.** In Snap Business Manager, as Organization Admin: Business Details → OAuth apps → create
   an app, accept the developer terms, set the redirect URL the connect screen shows. Self-serve, no review. Then either
   put its id and secret in the variables named in `docs/system/variables.md` for the native path, or in the Composio
   auth config named by `COMPOSIO_AUTH_SNAPCHAT`.
4. **LinkedIn Advertising API app.** At developer.linkedin.com, create a NEW app for the company page (a super admin of
   the page verifies it) and request the Advertising API product. Keep it separate from any Community Management API
   request: LinkedIn grants Community Management only on an app with no other products. Then create its Composio auth
   config and put its id in `COMPOSIO_AUTH_LINKEDIN_ADS` (named in variables.md).
5. **Google Business Profile.** If the company manages a profile verified for 60+ days with a website: file the GBP API
   access form with the Google Cloud project number. Quota stays at 0 until Google approves; no code before that.
6. **LinkedIn version, before enabling LinkedIn.** Run the LinkedIn org-access check on Preview (Owner_Tasks §هـ2, PR #284)
   and ask Composio support which `Linkedin-Version` toolkits `20260924_00` (linkedin) and `20260826_00` (linkedin_ads)
   send: version 202510 sunsets on 15 Oct 2026 (LinkedIn's official versioning page, checked 2026-10-12). Our code sends
   no `Linkedin-Version` header and calls no LinkedIn endpoint; `TOOLKIT_VERSION` pins a Composio snapshot, not a
   LinkedIn version. Only if a toolkit still sends 202510, move its pin to the newer Composio snapshot Composio names
   and re-check the allowlisted argument names. Nothing to change while Composio is dormant.
7. **X developer account.** Fund pay-per-use credits and set a spending limit in the X Developer Console. No new
   environment variable.
8. **Preview.** Scope Preview `APP_ORIGIN` to this branch for the B0 probe and the X field check.
9. **Live site.** Decide when the `COMPOSIO_*` names and the Hostinger daily cron go live; until then every reader stays
   dormant on thakeen.com.

## 10. Not now (phase D, after approvals)

Google Business Profile performance (after Google's approval; Composio has no toolkit for it), Snapchat organic (Snap
must allowlist our app through a Snap contact), TikTok Accounts API full insights, WhatsApp messaging analytics (needs
Meta Tech Provider status), Threads, Pinterest and X Ads. Each would be a reader feeding the same `PlatformPart`.

## 11. Open questions

- Should cron store syncs (`getSalesSnapshot().at`, twice daily) and cron ad syncs (`adsync:*`) keep counting as owner
  activity in Dana's gate? Today both do.
- Confirm with X that Thakeen's single app is not a "service bureau" use under the Developer Agreement (updated 27 Apr
  2026): owners authorise it by OAuth, and Thakeen posts and reads only the owner's own data inside Thakeen.
- Composio plan: what monthly tool-call allowance do we have? Daily reads per workspace grow with each platform.
- Privacy policy: platform figures, captions and ad copy go to the model inside the report prompt; Meta's Data Use
  Checkup and the other reviews will ask.

## 12. Rules (730-749) and tests

| Rule | Pins |
|---|---|
| 730 | `statsText` says traffic or ad spend are absent only when their block is absent |
| 731 | Each ad sync and upload writes its own `adstats:{scope}:{p}` from the raw rows; one never erases another; `savePerf` never writes it; `<ad_data>` in `statsFor` |
| 732 | Ad names and accounts in `adstats` are `clean(…, 80)`: a 100-character name is stored at 80 |
| 733 | A previous period comes only from a platform-returned range; a failed second read leaves no `prev` and never fails the sync; no change is written without `prev` |
| 734 | `select_property` accepts only an id from the stored lists, only on a Composio Google record; role `connectors` |
| 735 | `sync_social` and `sync_site` are role `read`, free, 6 an hour per workspace, 429 with `Retry-After`; `sync_ads` and `sync_x` the same 6 an hour |
| 736 | Cron site and social syncs do not open Dana's gate; an owner sync click does (`ownersync:{scope}`) |
| 737 | Social snapshot v2 and site figures: `null` is not read; a v1 snapshot is due |
| 738 | The Not-read list is built in code from connections, snapshots and the registry; the model never adds or drops one |
| 739 | Facebook Page: page id from the connection, constant metrics and fields, `access_token` never sent, only the page's own posts in the window |
| 740 | YouTube: `ids=channel==MINE`, constant metrics, checked dates; refused analytics keep public counts |
| 741 | All social readers share one 30 s deadline; one failed part never loses another |
| 742 | TikTok organic: read slugs only, constant fields, at most 2 pages; lifetime counters turned into changes by history |
| 743 | LinkedIn Ads: read slugs only, ad account from the connect-time listing, constant analytics call |
| 744 | X is read only on an owner click; at most one paid read per workspace per UTC day; 1 credit charged before the read with Dana's agent cap; refunded only when no read landed that day; a zero-post read is a success; an X app-side 402/403/429 never marks the owner's X for reconnect; Composio-routed X is never read |
| 745 | An X refresh makes exactly 2 requests (1 user, at most 10 posts, no pagination); its cost stays under `maxCostPerCreditUsd`, with and without VAT |
| 746 | History keeps at most 13 monthly rows per platform and is deleted with the account |
| 747 | `wipeAccount` deletes `adstats:{scope}:{p}` for every ad provider and `csv`, `xstats:{scope}` and `ownersync:{scope}` |
| 748 | LinkedIn page views: org URN from the connection, constant granularity; a refused admin scope keeps the rest of the part |
| 749 | Composio pins are the schema-read versions; the rule-652 importer check catches relative imports |

Amended rules, each with its test in the same commit: 663 (read slugs: add the Facebook, YouTube, LinkedIn page-stats,
TikTok, Snapchat account-stats and linkedin_ads reads), 664 (a Meta record with `pageId` is read; `connectedSources`
counts it), 665 (one 30 s deadline replaces the 25 s post budget), 668 (a change is written only where `prev` exists),
670 (read sources and the followers tile include every v2 part), 673 (a Facebook-only Meta record adds a daily line).
Rule 666 stays Instagram-only; each new platform's link host is pinned in its own rule (739, 740, 742) and X's in 744.

Every rule gets its test in `tests/` and its row in `docs/system/tests.md`; `flows.md` §50 describes the flow, and
`architecture.md`, `permissions.md` (the new connect actions and their roles), `variables.md`
(`COMPOSIO_AUTH_LINKEDIN_ADS`) and `costs.md` (X reads) are updated in the same commits.
