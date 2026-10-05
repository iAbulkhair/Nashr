# Reem phase 3 B1: calendar subscription feed (ICS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in login (owner or member) makes one private URL that a calendar app (iPhone, Google, Outlook) subscribes to, and sees the brand's open dated Reem items there, read only.

**Architecture:** Two small modules. `src/lib/feed-token.ts` is db-only (token, its two records, revoke) so team, account and auth code can call it without an import cycle. `src/lib/secretary-feed.ts` holds the per-request validity check, the item selection and `buildIcs`. One public GET route serves the file; three login routes create, check and stop the link. The record's own scope is the only scope ever read.

**Tech Stack:** Next.js 16 app router route handlers, Upstash Redis through `src/lib/db.ts`, Node `crypto`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-secretary-reem-b1-ics-feed-design.md` (rulings B1-R1..R8). Rulings made while planning: B1-R9..R11 (last section).

## Global Constraints

- Tenant isolation: the feed reads items only with the scope stored in the feed record (`sec:feed:{hash}`), never a value from the request. Never build a Redis key from request input other than the SHA-256 of a token that matched `^[A-Za-z0-9_-]{43}$`.
- Auth first: management routes call `currentUser()` then `forbid(...)` (`read` for GET, `feed.manage` for POST and DELETE, see Task 1). The public GET is the one route with no session; it has two `allow()` limits.
- A secret in the URL is allowed for this one route only (founder, 2026-10-05). Never log the token, never echo it in an error, 404 with an empty body for every failure.
- Token: 32 random bytes, base64url, 43 characters; only the SHA-256 hex is stored; the plain token is returned once.
- No `await db.*` inside a loop: `Promise.all` or `pmap` from `src/lib/parallel.ts`.
- Feed content: open items with a due date only; window due from 14 days before today to 365 days after; at most 500 events, nearest first; no notes, no description, no phone, no `RRULE`, no `VALARM`. `UID` `{itemId}@thakeen`, `SEQUENCE` = `rev`, timed events UTC with `DTEND` +30 min, all-day events `VALUE=DATE` on the brand-zone day with `DTEND` the next day.
- File safety: RFC 5545 text escaping after control and direction-override characters are removed; fold at 75 octets without splitting a UTF-8 character; CRLF.
- Headers on the file: `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`.
- Rate limits: `feed:ip:{ip}` 120 per 3600 s, `feed:t:{hash}` 60 per 3600 s (429 with `Retry-After: 3600`), management `sec:feed:{login}` 20 per 3600 s.
- No number, customer, price or promise of ours in the file or the card. Digits Latin. Every new string in both languages in `src/lib/app-i18n.ts`.
- Docs in the same commit as the change; one `docs/system/tests.md` row per rule; rules 530 to 549 (530 is the first free number on `main` at f0e7fde; re-check with `git grep -n "^| 53" origin/main -- docs/system/tests.md` before Task 1).
- `npm run check` green before every commit; `npx next build` is blocked locally and runs in CI. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

- Create `src/lib/feed-token.ts`: token, records, `createFeed`, `resolveFeed`, `getFeedStatus`, `revokeFeed`, `revokeFeeds`.
- Create `src/lib/secretary-feed.ts`: `feedHolds`, `feedItems`, `buildIcs`, `icsEscape`, `icsFold`.
- Create `src/app/api/secretary/feed/route.ts` (GET, POST, DELETE) and `src/app/api/secretary/feed/[token]/route.ts` (GET).
- Create `src/components/app/FeedCard.tsx`; render it in `src/components/app/TodoPanel.tsx` (the page that already hosts the Away panel).
- Modify `src/lib/roles.ts` (`feed.manage`), `src/lib/team.ts`, `src/lib/account.ts`, `src/app/api/auth/reset/route.ts`, `src/app/api/admin/users/[email]/route.ts`, `src/app/api/account/route.ts` (revocation), `src/lib/app-i18n.ts`, `src/lib/changelog.ts`, `src/lib/help.ts`.
- Tests: `tests/secretary-feed.test.ts` (new), `tests/role-gates.test.ts`. Docs: `docs/system/{flows,permissions,architecture,tests}.md`.

## Review Focus

- A title containing `\r\nEND:VEVENT\r\nBEGIN:VEVENT` or `‮` must not add a line or reorder text (Task 2).
- A 43-character token that is not base64url, a 44-character token, an empty path, `.ics` only, and `..%2f` all give the same empty 404 with no store read (Task 3).
- A login that was moved out of the brand (member removed, brand archived, owner suspended) with a still-stored record gets the same 404 as an unknown token (Task 3).
- Creating twice at once leaves exactly one working link, and a revoke racing a create never leaves a live orphan (Task 1).
- A recurring series with its `repeat` rule appears once, and a done or deleted item that is still in `sec:open` as a ghost does not appear (Task 2).
- An all-day item due on 5 October in Riyadh is `20261005`, not the day before; a timed item stays in UTC (Task 2).

---

### Task 1: Feed token, records, revoke, and the `feed.manage` action

**Files:**
- Create: `src/lib/feed-token.ts`
- Modify: `src/lib/roles.ts` (`Action` union, `MIN_ROLE`, `IMPERSONATION_BLOCKED`)
- Test: `tests/secretary-feed.test.ts` (new file, `describe("feed token (rules 530-533)")`)
- Docs: `docs/system/tests.md` rows 530-533

**Interfaces:**
- Produces:
  - `export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/`
  - `export const FEED_KEYS = { rec: (hash: string) => \`sec:feed:${hash}\`, of: (login: string) => \`sec:feedof:${login}\` }`
  - `export type FeedRecord = { login: string; scope: string; lang: "ar" | "en"; createdAt: string }`
  - `export const hashFeedToken = (token: string): string` (SHA-256, hex)
  - `export async function createFeed(login: string, scope: string, lang: "ar" | "en"): Promise<string | "busy">` returns the plain token, or `"busy"` when the lock could not be taken.
  - `export async function resolveFeed(token: string): Promise<{ hash: string; rec: FeedRecord } | null>`: no store read when `FEED_TOKEN` fails.
  - `export async function getFeedStatus(login: string): Promise<{ exists: boolean; createdAt: string | null }>`
  - `export async function revokeFeed(login: string): Promise<void>`: idempotent.
  - `export const revokeFeeds = (logins: string[]) => pmap(logins, revokeFeed)`.
  - In `roles.ts`: action `"feed.manage"`, `MIN_ROLE["feed.manage"] = "member"`, added to `IMPERSONATION_BLOCKED`.

- [ ] **Step 1: Write the failing tests** (in `tests/secretary-feed.test.ts`, with `newUser`, `newMember` from `tests/helpers/session`)
  - `"rule 530: only the SHA-256 of the token is stored, the plain token never"`: `createFeed("a@x.test", "a@x.test", "ar")` returns a string matching `FEED_TOKEN`; `db.get(FEED_KEYS.rec(hashFeedToken(token)))` equals `{ login, scope, lang, createdAt }`; no key and no stored value in the fake store contains the plain token.
  - `"rule 531: renewing deletes the old record and sec:feedof keeps one per login"`: create twice; `resolveFeed(first)` is null, `resolveFeed(second)` is not; `db.get(FEED_KEYS.of(login))` equals `hashFeedToken(second)`.
  - `"rule 532: two creates at once leave exactly one working link; revoke is idempotent"`: `Promise.all([createFeed(...), createFeed(...)])` gives at most one `"busy"` and exactly one `sec:feed:*` record; `revokeFeed` twice leaves no `sec:feed:*` and no `sec:feedof:*`.
  - `"rule 533: feed.manage is member-level and blocked while a founder impersonates"`: `can` is true for owner, admin and member actors and false for a `kind: "founder"` actor; `MIN_ROLE["feed.manage"]` is `"member"`.
- [ ] **Step 2: Run** `npx vitest run tests/secretary-feed.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `feed-token.ts` with the signatures above. Token: `randomBytes(32).toString("base64url")`. Lock: `db.lockOwned(\`lock:feed:${login}\`, 10)` and `db.unlockOwned`; `createFeed` order is read old hash, set new record, set `of`, delete old record, all under the lock; lock not won on the single try gives `"busy"`. `revokeFeed` tries the same lock up to 20 times, 50 ms apart, then revokes anyway so a held lock never keeps a link alive (B1-R10). The module imports only `./db`, `./parallel` and `node:crypto`. Add the action to `roles.ts`.
- [ ] **Step 4: Run** the same command — expect PASS; run `npx vitest run tests/role-gates.test.ts` — expect still green.
- [ ] **Step 5: Commit** `feat(reem): B1 feed token store and feed.manage action` (tests, `feed-token.ts`, `roles.ts`, tests.md rows).

### Task 2: The file: item selection and `buildIcs`

**Files:**
- Create: `src/lib/secretary-feed.ts` (`icsEscape`, `icsFold`, `feedItems`, `buildIcs`)
- Test: `tests/secretary-feed.test.ts` (`describe("feed content (rules 534-538)")`)
- Docs: tests.md rows 534-538

**Interfaces:**
- Consumes: `listOpenItems(scope)` from `src/lib/secretary.ts`; `zoneDay`, `addDays`, `type SecItem` from `src/lib/secretary-agenda.ts`; `type Zone` and `zoneOf` from `src/lib/zones.ts`.
- Produces:
  - `export const icsEscape = (s: string): string`: removes control characters and the direction overrides `‪-‮⁦-⁩‎‏`, turns any line break into a space, then escapes `\`, `;` and `,`.
  - `export const icsFold = (line: string): string`: folds at 75 octets, continuation lines start with one space, never splits a UTF-8 sequence, joins with `\r\n`.
  - `export async function feedItems(scope: string, now: number): Promise<SecItem[]>`: open, `dueAt` set, due between `now - 14 d` and `now + 365 d`, ascending by `dueAt` then `id`, first 500.
  - `export function buildIcs(items: SecItem[], o: { lang: "ar" | "en"; zone: Zone; origin: string; now: number }): string`: whole calendar `BEGIN:VCALENDAR` to `END:VCALENDAR`, CRLF line ends, header lines from spec section 2 (`X-WR-CALNAME` "ذكين: مهامي" or "Thakeen: my to-dos", `REFRESH-INTERVAL;VALUE=DURATION:PT1H`, `X-PUBLISHED-TTL:PT1H`).

- [ ] **Step 1: Write the failing tests**
  - `"rule 534: only open dated items in the window, nearest first, 500 at most"`: seed open items due at -20 d, -10 d, +5 d, +400 d, an undated one, a done one and a deleted one; `feedItems` holds exactly the -10 d and +5 d ones in that order. Seed 520 dated items: 500 come back, the earliest 500.
  - `"rule 535: a recurring series shows its one open copy; a ghost id in sec:open does not appear"`: a series item with `repeat` appears once; an id left in `SEC_KEYS.open` whose item is done does not appear.
  - `"rule 536: a timed item is UTC with a 30 minute end, an all-day item is a date in the brand zone"`: timed `2026-10-05T09:00:00.000Z` gives `DTSTART:20261005T090000Z` and `DTEND:20261005T093000Z`; an all-day item with `dueAt` `2026-10-05T20:59:00.000Z` in Asia/Riyadh gives `DTSTART;VALUE=DATE:20261005` and `DTEND;VALUE=DATE:20261006`; `UID` is `{id}@thakeen`, `SEQUENCE` equals `rev`, `DTSTAMP` and `LAST-MODIFIED` equal `updatedAt` in UTC form.
  - `"rule 537: no notes, description or phone in the body"`: an item with a note `SECRET-NOTE`, description `SECRET-DESC` and phone `966500000000` gives a body with none of the three; `DESCRIPTION` is one line, who acts (`عليّ أنا` or `ننتظر {name}`, English `Mine` or `Waiting on {name}`) plus the to-do page URL on the given origin; the body contains no price or count of ours.
  - `"rule 538: file safety"`: a title `a,b;c\r\nEND:VEVENT\r\nBEGIN:VEVENT‮` gives a body with exactly one `BEGIN:VEVENT` and one `END:VEVENT`, the title on one escaped line; a 200-character Arabic title folds so no physical line exceeds 75 octets and unfolding then decoding gives the original; the body uses `\r\n` only.
- [ ] **Step 2: Run** `npx vitest run tests/secretary-feed.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the four exports. `feedItems` reuses `listOpenItems` for its ghost filter. The all-day `DTEND` is the next local day via `addDays`. The two "who acts" strings are literals here and move to `appDict` in Task 6.
- [ ] **Step 4: Run** — expect PASS. Run `npm run check`.
- [ ] **Step 5: Commit** `feat(reem): B1 ICS builder and item selection`.

### Task 3: Validity check and the public feed route

**Files:**
- Modify: `src/lib/secretary-feed.ts` (add `feedHolds`)
- Create: `src/app/api/secretary/feed/[token]/route.ts`
- Modify: `tests/role-gates.test.ts` (route table: `"GET /api/secretary/feed/[token]": "public-read"`)
- Test: `tests/secretary-feed.test.ts` (`describe("public feed route (rules 539-542)")`)
- Docs: tests.md rows 539-542

**Interfaces:**
- Consumes: `resolveFeed`, `FEED_TOKEN`, `type FeedRecord` (Task 1); `feedItems`, `buildIcs` (Task 2); `allow`, `clientIp` from `src/lib/rate.ts`; `getLogin` from `src/lib/auth.ts`; `listBrands` from `src/lib/brands.ts`; `getBrand` from `src/lib/brand`; `zoneOf`.
- Produces: `export async function feedHolds(rec: FeedRecord): Promise<boolean>`: the login still exists, is active, and the brand in `rec.scope` is still its own:
  - owner login: `getLogin(rec.login)` is `kind: "owner"`, not `suspended`, and `rec.scope` is `rec.login` or `rec.login#{id}` with that brand `active` in `listBrands(rec.login)`;
  - member login: `kind: "member"` with a non-null `owner` (`getLogin` already checks the roster), `member.disabled` falsy, role `admin` or `member`, owner not suspended, `member.acceptedAt >= owner.createdAt`, and `rec.scope` belongs to `member.memberOf` with that brand active;
  - anything else false.
- Route `GET /api/secretary/feed/{token}`: strip one trailing `.ics`; a value failing `FEED_TOKEN` is a 404 before any `allow` or store read; then `allow("feed:ip:{ip}", 120, 3600)` (429, `Retry-After: 3600`), `resolveFeed`, `allow("feed:t:{hash}", 60, 3600)`, `feedHolds`, items read with `rec.scope`. Every failure is the same 404 with an empty body. The handler has no `db.set`, `save*` or other write (the `public-read` gate scans for them; `allow` is not one).

- [ ] **Step 1: Write the failing tests** (call the route with `new Request("http://x/api/secretary/feed/" + t)` and `params({ token })`)
  - `"rule 539: malformed, unknown, revoked and no-longer-valid logins give the same empty 404, and a malformed token reads nothing"`: for `"x"`, a 44-character token, `".ics"`, an unknown 43-character token, a revoked token, a member removed after the feed was made, an owner suspended, an archived brand: status 404, `await res.text()` is `""`, headers equal. With a spy on `db.get`, the malformed cases call it zero times and `allow` zero times.
  - `"rule 540: tenant isolation, the feed reads only the record's scope"`: two brands of one owner and a second owner, each with a dated item; the feed made in brand A shows only A's item; a member's feed shows the owner's brand scope, never the member's own address as a scope.
  - `"rule 541: rate limits answer 429 with Retry-After before any item read"`: the 121st call from one IP and the 61st for one token; a spy on `listOpenItems` shows it was not called on the refused call.
  - `"rule 542: headers"`: 200 has `text/calendar; charset=utf-8`, `private, max-age=300`, `no-referrer`, `noindex, nofollow`, no `set-cookie`; the `.ics` suffix returns the same body as the bare token.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `feedHolds` and the route. Brand zone from `zoneOf(await getBrand(rec.scope))`; origin from `appOrigin()` (a trusted constant, never the request's URL or `Host`).
- [ ] **Step 4: Run** `npx vitest run tests/secretary-feed.test.ts tests/role-gates.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(reem): B1 public ICS feed route with validity check and two rate limits`.

### Task 4: Management routes

**Files:**
- Create: `src/app/api/secretary/feed/route.ts` (GET, POST, DELETE)
- Modify: `tests/role-gates.test.ts` (three entries)
- Test: `tests/secretary-feed.test.ts` (`describe("feed management (rules 543-544)")`)
- Docs: tests.md rows 543-544

**Interfaces:**
- Consumes: `createFeed`, `getFeedStatus`, `revokeFeed` (Task 1); `currentUser`, `sc` from `src/lib/auth`; `forbid` from `src/lib/roles`; `allow`.
- Produces:
  - `GET` → `{ ok: true, exists: boolean, createdAt: string | null }` (`forbid(u, "read")`), never the link.
  - `POST` → `{ ok: true, url, webcal }` (`forbid(u, "feed.manage")`); `url` is `{appOrigin()}/api/secretary/feed/{token}.ics`, `webcal` the same with a `webcal://` scheme. The login is `u.actor.email` for a member and `u.email` for an owner or founder; scope is `sc(u)`; lang from the body `{ lang: "ar" | "en" }`, default `u.lang`. 409 `{ ok: false, error: "busy" }` when `createFeed` returns `"busy"`.
  - `DELETE` → `{ ok: true }`, idempotent (`forbid(u, "feed.manage")`).
  - All three: `currentUser()` first (401), then the gate, then `allow("sec:feed:{login}", 20, 3600)` (429 `too_many`). Gate entries: `"GET /api/secretary/feed": g("member", "read")`, `"POST /api/secretary/feed": g("member", "feed.manage")`, `"DELETE /api/secretary/feed": g("member", "feed.manage")`.

- [ ] **Step 1: Write the failing tests**
  - `"rule 543: anonymous 401; owner, admin and member 200; a founder impersonating gets 403 on POST and DELETE; GET never returns the link"`.
  - `"rule 544: create, status, stop; stop twice is 200; the stopped link gives 404 on the public route; the 21st call in an hour is 429"`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the three handlers.
- [ ] **Step 4: Run** both test files and `npm run check` — expect PASS (the route-gate scan now sees the three new keys).
- [ ] **Step 5: Commit** `feat(reem): B1 feed management routes`.

### Task 5: Revocation wiring

**Files:**
- Modify: `src/lib/team.ts` (`dropMember`, `wipeTeam`), `src/lib/account.ts` (`wipeAccount`), `src/app/api/auth/reset/route.ts:65`, `src/app/api/admin/users/[email]/route.ts:110`, `src/app/api/account/route.ts:60`
- Test: `tests/secretary-feed.test.ts` (`describe("feed revocation (rules 545-546)")`)
- Docs: tests.md rows 545-546

**Interfaces:**
- Consumes: `revokeFeed`, `revokeFeeds` (Task 1).
- Produces: a feed ends where an account's MCP token ends and where a login ends:
  - `dropMember` calls `revokeFeed(email)` once the member is removed;
  - `wipeTeam(owner)` revokes every roster member's feed inside its existing `pmap`;
  - `wipeAccount(email)` revokes the owner's feed and every roster member's (named from `members:{owner}` as `wipeTeam` does, before the roster is deleted);
  - password reset, founder reset and password change call `revokeFeed(login)` next to `revokeAllMcp`; account deletion is covered by `wipeAccount`.

- [ ] **Step 1: Write the failing tests**
  - `"rule 545: removing a member, resetting a password and changing a password end that login's feed"`: a member removed through `removeMember`, then an owner password reset (`POST /api/auth/reset`), the founder reset (`/api/admin/users/[email]`), and an owner password change (`/api/account`): each time the public route answers 404 and both keys are gone.
  - `"rule 546: deleting the account leaves no sec:feed or sec:feedof key for the owner or any member"`: owner and two members with feeds; `wipeAccount(owner)`; scan the fake store: none left.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the six call sites; no `await` inside a loop.
- [ ] **Step 4: Run** `npm run check` — expect PASS (existing team and account tests stay green).
- [ ] **Step 5: Commit** `feat(reem): B1 feed links end with the login (removal, reset, deletion)`.

### Task 6: The card on My to-dos, text, changelog and help

**Files:**
- Create: `src/components/app/FeedCard.tsx`
- Modify: `src/components/app/TodoPanel.tsx` (render the card below the Away panel), `src/lib/app-i18n.ts` (both `todo` objects: key group `feed`), `src/lib/secretary-feed.ts` (read the two "who acts" strings from `appDict`), `src/lib/changelog.ts`, `src/lib/help.ts`
- Test: `tests/secretary-feed.test.ts` (`describe("feed card (rules 547-548)")`)
- Docs: tests.md rows 547-548

**Interfaces:**
- Consumes: the routes of Tasks 3-4.
- Produces: `export default function FeedCard({ t, lang }: { t: AppDict; lang: "ar" | "en" })` (client component). States: loading, none (button "Create my link"), created (link and `webcal://` version with Copy, the warning, one sentence per app; the link lives in component state only and is gone when the page is left), exists (since date, Renew, Stop with an inline confirm). Writes go through `useOneWrite`. Strings in `appDict[lang].todo.feed`: title, create, renew, stop, copy, copied, since, warning (anyone with the link sees your dated task titles; renew it if shared by mistake; the calendar app updates on its own schedule), iphone, google (does not accept `webcal://`), outlook, busy, error, mine, waiting.

- [ ] **Step 1: Write the failing tests**
  - `"rule 547: both languages carry every feed string, Latin digits, no number of ours"`: the key sets of `appDict.ar.todo.feed` and `appDict.en.todo.feed` are equal; no Arabic-Indic digit in any value; nothing from the forbidden list in `tests/pricing-copy.test.ts` appears.
  - `"rule 548: the card shows the link once"`: render `FeedCard` in the created state (the render pattern other panel tests use) and assert the link is present; in the exists state assert the since date is present and the link is not.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the card and strings. Changelog entry: `tag: "new"`, dated 2026-10-05 with the same "set to the merge day" comment A2 has. One help item under the Reem topic.
- [ ] **Step 4: Run** `npm run check` — expect PASS. Then `preview_start` the dev server and check the to-do page at 375 px and in dark mode (long Arabic link wrapping, Copy buttons); report what was seen.
- [ ] **Step 5: Commit** `feat(reem): B1 subscribe-from-your-calendar card on My to-dos`.

### Task 7: Docs and the last gates

**Files:**
- Modify: `docs/system/flows.md` (new section after 40: "41. Reem's calendar subscription feed"; no new environment variable, stated there), `docs/system/permissions.md` (two route rows, the `feed.manage` action, and a named-exception paragraph with the section 6 limits), `docs/system/architecture.md` (route counts from `find src/app/api -name route.ts | wc -l` and the handler count, the two routes in the Workspace row, the two modules, keys `sec:feed:{hash}`, `sec:feedof:{login}`, `lock:feed:{login}`), `docs/system/tests.md` (rows 530-548 all present, no duplicate numbers), `docs/superpowers/specs/2026-10-05-secretary-reem-b1-ics-feed-design.md` (sections 8 and 9: the card is on My to-dos, B1-R9)

- [ ] **Step 1:** Update the docs; every count equals what its command prints.
- [ ] **Step 2:** Run `npm run check` — expect green, including `role-gates`, the docs pins and `pricing-copy`.
- [ ] **Step 3:** Push and open a **draft** PR from `claude/reem-b1-ics-feed` with the rulings (B1-R1..R11), the named residual risk (platform request logs hold the path), and the post-merge checks: on production an unknown 43-character path answers 404 with an empty body, and `GET /api/secretary/feed` without a session answers 401. Do not merge.
- [ ] **Step 4: Commit** `docs(reem): B1 flows, permissions (named URL-secret exception), architecture and tests`.

## Rulings made while planning

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| B1-R9 | The card goes on My to-dos (`TodoPanel`), not on `/app/calendar`. Spec sections 8 and 9 named the calendar page, which is the publishing calendar of approved posts. | The feed is about Reem's items, and that is where the items and the Away panel live | Moving a card is a one-file change |
| B1-R10 | A held lock makes create answer 409 `busy`; revoke retries 20 times, then revokes anyway | A link must never outlive a revoke; a failed create is a harmless retry | One retry click, or a revoke that is 1 s slower |
| B1-R11 | Validity uses `getLogin` plus the checks `resolveSession` makes that need no session (disabled, suspended, roster, `acceptedAt` against owner `createdAt`, brand active), not the session-stamp checks | A feed has no session; the rest decides whether the login still belongs to that brand | A login restored by hand would see its old feed work again until renewed |
