# Composio evaluation: a managed connection layer for social, ads, analytics and calendars

> **Status update (2026-10-13, from `git log origin/main`):** the experiment became the build: Composio is installed as #272 and #281 (2026-10-08, in `production`), dormant until the `COMPOSIO_*` variables are set; the decision record is in `docs/system/flows.md` section 11a. The status line below is the state when the document was written.

Status: draft for the founder's review, 2026-10-05. This is an **experiment spec**, not a decision to adopt. It says what is tested, how, what may and may not touch customers, and what result adopts, trims or rejects Composio. Stores (Salla, Zid, WooCommerce, WordPress) are a separate spec (`2026-10-05-store-connectors-design.md`) and are not tested here.

## 1. Goal and what the founder decided

Find out whether Composio can carry the connectors Thakeen has not built yet (and, where it is better, some it has), at a lower cost and sooner than building each one, without weakening any rule the code enforces today.

Decided by the founder on 2026-10-05:

- Composio is tested through its **REST API from the server**. No Composio tool, key or MCP endpoint is ever given to a model.
- **Approval stays in code.** Publishing, ad changes and anything that spends money or reaches a customer's audience go through the gates that exist (`publish` role, `publishOnce`, brand rules, the owner's approval), not through a prompt.
- One branch for the experiment (`claude/composio-eval-spec` for this spec, the build on its own branch later), one for stores. The two do not share files.
- Every platform Thakeen targets is in scope for the *evaluation*; the first two built are **Instagram** and **Google Calendar**.

Not in this spec: adopting Composio for production customers, replacing Meta, X, Shopify or WordPress code that works, store connectors, Calendly and Cal.com (B2 already decides direct webhooks, `2026-10-05-secretary-reem-b2-bookings-design.md`; Composio is re-tested there only if B2 fails), any billing change, any customer-facing wording that names Composio.

## 2. What exists today, and what Composio offers

Today (from `src/lib/connectors/registry.ts`, `working.ts`, `publish.ts`): publishing works for WordPress, Shopify, Telegram, X, Facebook and Instagram (through the one `meta` connection). `google`, `linkedin` and `tiktok` can be connected but nothing publishes or reads through them (they are not in `WORKING_PROVIDERS`). Ad results are read for `meta_ads` and `snapchat` only. Calendars: the B1 ICS feed is merged; B2 (bookings) is specified; B3 (Google and Outlook busy times) is not.

What Composio's toolkit pages list (read 2026-10-05; **the pages list tools, they do not prove the tools work**, which is what section 6 tests):

| Platform | Tools listed | Write | Read / analytics | Auth the page states |
|---|---|---|---|---|
| Instagram | 29 | publish media, carousel, comments, replies, messages | media and user insights, comments, stories, publishing limit | managed app; own app allowed |
| Facebook | 39 | page text, photo, video and scheduled posts, comments, messages | page and post insights | managed app; own app allowed |
| X | 78 | post, delete, media upload, DMs, likes, retweets, lists | timelines, recent and full-archive search, users, followers, mentions, post analytics, counts | managed OAuth 2.0 |
| LinkedIn | 22 | personal and organization posts, articles, comments | share and page statistics, followers, company info | managed; company pages need a management role |
| TikTok | 10 | publish video, upload, post photo | user stats, publish status, list videos | own app required |
| Meta Ads | 50 | campaign, ad set, ad, creative, custom audience | insights per account, campaign, ad set, ad | own app required |
| Google Ads | 9 | mutate campaigns and ad groups, customer lists | GAQL search stream | managed; no budget tool listed |
| Google Calendar, Outlook | not read in detail | not needed | free/busy and events (B3 needs busy times only) | to confirm in Task 0 |
| Snapchat, YouTube, Business Profile, GA4, Search Console, Klaviyo, Brevo, Telegram, WhatsApp | listed as present | to confirm | to confirm | to confirm |

Pricing page (2026-10-05): free plan 100,000 tool calls, 50,000 triggers, 3 team members, hard cap; Pro $29 a month with $29 of usage credit and $0.0003 a call beyond; a Composio page also says only 20,000 of the free calls go through Composio's managed apps. Whether the free plan may be used commercially, and whether connected accounts are limited or priced, is not stated: asked in Task 0.

**X has its own cost.** X's API is pay-per-use since February 2026 (secondary sources: about $0.005 a post read, $0.015 a plain post, $0.20 a post with a link; Basic and Pro closed to new signups). Composio's page does not say whether this is inside its price or billed to the app owner. The evaluation records which, because a link in 30 posts a month would cost about $6 a customer if it is ours.

## 3. Architecture of the experiment

Off by default; nothing changes for any customer unless an owner opts in on a pilot account.

- **Adapter** `src/lib/connectors/composio.ts`: the only file that knows Composio. Exposes `composioConnect(scope, provider)`, `composioExecute(scope, provider, tool, args)`, `composioRevoke(scope, provider)`. Everything outside it sees `Connection` records and `PublishResult`, as today.
- **Flag**: `COMPOSIO_API_KEY` (secret, never logged) and `COMPOSIO_PROVIDERS` (comma list of provider ids allowed through Composio; empty means none). With either unset the adapter refuses and the app behaves as now (`isAvailable` false for a Composio-routed provider).
- **Routing**: a provider in `COMPOSIO_PROVIDERS` is connected through Composio's hosted connect flow instead of `oauth.ts`. The result is stored as a normal encrypted `Connection` (`provider`, `data: { composioAccountId }`, `meta.via = "composio"`), so listing, disconnect, `needsReconnect` and the Integrations card keep one path. The registry gains an optional `via`.
- **Identity sent to Composio**: an opaque id, `HMAC-SHA256(CONNECT_SECRET, scope)` truncated, never an email, name or brand text. The mapping is recomputed from `sc(u)` on every call; nothing is read from a request.
- **Publishing**: `publishWith` gets new `case`s that call the adapter only for a provider in the allow list; the gates above it (`publishTask` called through `publishOnce`, `forbid(u, "publish")`, brand rules, the approval check, `hasArtwork`) are not touched or duplicated.
- **Reads** (Instagram insights, X analytics, Google Calendar busy times, ad results) go through the same functions that already feed the Reports page and Reem, producing the same snapshot types; they add no new store.

## 4. Rules the code enforces (the part that must not move)

1. **Tool allowlist in code.** The adapter holds one map `provider → { read: [...], write: [...] }` of exact tool slugs. A slug not in the map is refused before any request. `write` slugs are callable only from `publishWith` (or a later approved write path); every other caller can pass only `read` slugs. A test fails if a new slug appears without a test row.
2. **No model access.** No model, chat tool, MCP tool or prompt receives the Composio key, an account id or a tool list. `chat.ts` and `mcp.ts` do not import the adapter (a test checks the import graph).
3. **Publishing and spending are checked in code**, as today: role `publish`, owner approval of the item, brand rules, one send per item and platform (`publishOnce` lock and marker). **Composio retries are treated as unknown outcomes:** a timeout from Composio leaves the `pubtry` marker (the existing "result unknown, check the platform" path); the adapter never retries a write itself.
4. **Ads: no write in this experiment.** Meta Ads and Google Ads are read for results only. Creating or changing a campaign needs a separate spec (budget ceilings, owner approval of each change, a spend log) and is listed in section 9.
5. **Tenant isolation.** A connection is read with `getConnection(sc(u), provider)`; the Composio account id comes from that record only, never from a request or a webhook body.
6. **Untrusted input.** Comments, messages, captions, calendar event titles and insights text returned by Composio are data: rendered through `render` where shown, `csvSafe` in exports, never placed in a prompt as instructions (existing prompt-stamp rules apply). Calendar reads keep only start, end and "busy"; no title, attendee or location is stored (the B1/B2 privacy line).
7. **Secrets.** `COMPOSIO_API_KEY` is compared and sent only server-side, named in `docs/system/variables.md`, never in a URL, response, log or error text. Composio error bodies are cut to a short code before logging or showing.
8. **Webhooks and triggers: none in this experiment.** Reads are polled by the existing sync actions. If a later round adds Composio triggers, that is a public route with a signature check (`sameSecret`), a rate limit and a body cap, specified then.
9. **Disconnect revokes at both ends.** `DELETE /api/connect/{provider}` calls `composioRevoke` first, then deletes the local record; a failed revoke keeps the local record marked `needsReconnect` and tells the owner, never "disconnected" while Composio still holds the grant. `wipeAccount` revokes every Composio connection it can name before it deletes.
10. **Rate and cost limits.** Every adapter call counts against `allow("composio:{scopeHash}", …)` per account per hour and a global monthly counter `composio:calls:{yyyymm}`; at 80% of the plan's included calls the founder is told (`pushNotif` to the founder, not to customers) and at 100% the adapter refuses new calls rather than pay overage unannounced.
11. **Pilot only.** Real customers are connected through Composio only after (a) the data processing and storage-region questions in Task 0 are answered in writing and (b) the founder says so. Until then the pilot accounts are the founder's own test accounts.
12. **No invented claims.** Nothing in the product, help or site names Composio or promises a platform works until section 7's pass rule is met for it.

## 5. The first two builds

**Instagram (publish and insights).** Target `instagram` already exists in `targetsFor` (needs an artwork image). With `instagram` in `COMPOSIO_PROVIDERS`: the connect flow goes through Composio; `publishWith` `case "instagram"` calls the adapter's carousel/media publish with the item's `imageUrl` and body after the existing `hasArtwork` and `instagram_needs_image` checks; the content publishing limit tool is read before posting and a refusal maps to a clear owner message. Insights feed the existing performance import. Facebook is the same shape and follows if Instagram passes.

**Google Calendar (busy times, B3).** Read-only: free/busy for the owner's chosen calendar into Reem's agenda as busy blocks. Same adapter, a `google_calendar` provider, one read slug. The owner chooses which calendar counts as the brand's (the rule decided for B3: the owner picks the brand's calendar from their own, and Thakeen states the account it reads; an email's being "the brand's" is not inferred). Reem never writes to a calendar.

## 6. Task 0 and the measured protocol

**Task 0 (before any code):** read Composio's current API reference and write down the exact connected-account, auth-config and tool-execution calls (this spec does not guess them); then get written answers to: (1) may the free or Pro plan carry paying customers; (2) are connected accounts limited or priced; (3) where are tokens stored and processed, and is there a data processing agreement fit for Saudi PDPL; (4) does the managed Instagram and Facebook app stay approved, who bears Meta's review, and what shows on the consent screen; (5) is X's API cost inside the price; (6) will they add Salla and Zid (answers feed the stores spec); (7) which calls count as a "tool call" (a failed one, a paginated read).

**Protocol per platform** (the founder's own test accounts, fixtures where the platform has a sandbox): run each read and write slug in the allowlist and record, in `docs/superpowers/evals/2026-10-05-composio-results.md` (created by the run): success rate over 50 attempts, latency p50 and p95, how a revoked token surfaces (does it reach `refusedToken` and `needsReconnect`), how a platform 4xx and 5xx appear, whether any retry happened inside Composio, calls counted per operation, and one duplicate-post probe (a forced timeout on a write: does the item show "result unknown" and never post twice).

## 7. Pass rule and the decision

A platform **passes** when all hold: reads succeed in at least 95 of 100 tries with p95 under 4 seconds; zero duplicate posts across the 50 write attempts and the timeout probe; a revoked token reaches `needsReconnect` within one sync; the answers to questions 1 to 3 allow the use; and the cost per customer per month at the pilot's call volume is under a ceiling the founder sets before the run (suggested: 25 SAR, which keeps the 60% margin floor on Starter).

Outcomes: **adopt** for the platforms that pass and that Thakeen has not built (LinkedIn, TikTok, Google Business Profile, YouTube, Google Calendar, Outlook, GA4, Search Console); **keep direct** where the current code already works and Composio adds only a dependency (Meta, X, Shopify, WordPress, Telegram) unless it is clearly cheaper or more reliable; **reject** if question 1, 3 or 4 fails. The founder decides; the results file is the evidence.

## 8. Cost model (assumptions, to be replaced by measured numbers)

At 1,500 calls a customer a month: 100 customers is 150,000 calls (about $29 on Pro, the $15 overage covered by the credit); 1,000 customers is 1.5 million calls (about $420 to $450). X's own charges, any Meta or Google review cost and the engineering time are not in these numbers.

## 9. Files, docs and tests

New: `src/lib/connectors/composio.ts` and the allowlist; tests under `tests/` (rule numbers set in the plan, one per rule 1 to 11 above, plus the table of slugs). Changed: `registry.ts` (`via`), `publish.ts` (cases), `working.ts` (the list stays equal to the code paths, `tests/connectors-working.test.ts`), `api/connect/[provider]` (revoke on delete), `wipeAccount`. Docs in the same commit: `variables.md` (`COMPOSIO_API_KEY`, `COMPOSIO_PROVIDERS`), `flows.md` (connect and revoke), `permissions.md` (no new route unless the connect start route changes), `tests.md`.

Separate specs needed before any of these: ad **writes** (budget ceilings and per-change approval), Composio triggers, and moving a built connector off direct code.

## 10. Questions for the founder

1. The per-customer cost ceiling for the pass rule (suggested 25 SAR).
2. Whether the experiment may use the free plan's 20,000 managed-app calls for the first week, or only your own Meta, X and TikTok apps from day one.
3. Which pilot accounts (yours) for Instagram, X and Google Calendar.
4. Whether LinkedIn company pages, TikTok and Google Business Profile are wanted in the first wave or after Instagram and Calendar pass.

## 11. Rulings made while writing this spec

- C-R1: ad writes are out of this experiment even though Meta Ads lists 50 tools; money moves need their own approval spec.
- C-R2: Composio's retries are not trusted for writes; an unknown outcome uses the existing publish marker.
- C-R3: the identity sent to Composio is an HMAC of the scope, so no email or brand name leaves the product.
- C-R4: Calendly and Cal.com stay with B2's direct design; Composio is not tested there unless B2 fails.
- C-R5: tool counts and auth statements come from Composio's public toolkit pages read on 2026-10-05 and are claims to verify, not facts about behavior.
