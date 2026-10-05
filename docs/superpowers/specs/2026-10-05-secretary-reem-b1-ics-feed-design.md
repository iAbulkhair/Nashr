# Reem phase 3 B1: a calendar subscription feed (ICS)

Status: draft for the founder's review, 2026-10-05. Part B of phase 3 (see `2026-10-02-secretary-reem-phase3a-design.md`, section "Out of scope for A"); B2 (Calendly and Cal.com) and B3 (Google and Outlook busy times) are separate specs.

## 1. Goal and what the founder decided

Reem's open, dated items show up in the founder's own calendar app (iPhone, Google, Outlook) with no account linking: the member adds one private URL once, and the calendar app keeps it up to date.

Decided by the founder on 2026-10-05:

- **One link per member** (not one per brand). Each login makes, renews and stops its own link.
- **A private link in the URL is accepted** for this one route, as a narrow exception to the rule "secrets never in URLs" (calendar apps cannot send a header). Section 6 fences it.
- One direction only: Reem gives, the calendar takes. Nothing a calendar app does changes an item.

Not in B1: writing from a calendar into Reem, a brand-wide link, alarms (`VALARM`), `RRULE`, notes or descriptions in the feed, Calendly and Cal.com (B2), OAuth busy times (B3).

## 2. What the feed holds

The brand's open items that have a due date, the same set the to-do page shows any member, read with the brand's own scope (`SEC_KEYS.open`, `listOpenItems`). Not in the feed: done, deleted and undated items; notes (private or not) and the description; the inbox links.

- Window: due from 14 days before today to 365 days after, nearest first, at most 500 events. A longer list is cut at 500 with no marker (a calendar app cannot show one).
- A recurring series shows only its one open copy (A2 keeps one open copy per series), as a plain event. No `RRULE`: it stays correct for Hijri and "every N" rules because Reem, not the calendar, decides the next date.
- Event fields, in the language stored with the link (Arabic or English, section 3): `SUMMARY` is the title; `DESCRIPTION` is one line, who acts ("عليّ أنا" / "ننتظر {name}") plus the app link; `URL` is the to-do page. `UID` is `{itemId}@thakeen`; `SEQUENCE` is `rev`; `DTSTAMP` and `LAST-MODIFIED` are `updatedAt`; `STATUS:CONFIRMED`.
- Time: a timed item is `DTSTART` in UTC (`...Z`) with `DTEND` 30 minutes later; an all-day item is `DTSTART;VALUE=DATE` on its local day (the brand's zone) with `DTEND` the next day. The calendar's clock does the local conversion, so Hijri and zones need nothing else.
- Calendar header: `X-WR-CALNAME` "ذكين: مهامي" (English "Thakeen: my to-dos"), `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H` as hints only. Calendar apps poll on their own schedule and may be late; the page says so.

## 3. The token and its records

- Token: 32 random bytes, base64url (43 characters). Only its SHA-256 (hex) is stored; the plain token exists once, in the answer that creates it. A lost link is renewed, not recovered.
- `sec:feed:{hash}` → `{ login, scope, lang, createdAt }`. `scope` is `sc(u)` at creation (the brand that login was working in), `login` is the signed-in login's email, `lang` the page language.
- `sec:feedof:{login}` → the hash of that login's current link (one link per login; creating again replaces it and deletes the old `sec:feed:{hash}`).
- No expiry. It ends by Stop, Renew, member removal, account deletion or password reset (section 5).

At every request the record's `scope` and `login` are checked, never trusted alone: the login must still belong to that scope (the owner, whose scope is their email, or a member whose owner's scope equals `scope`), be active (not suspended, not removed). Any failure is the same 404 as an unknown token. The scope used to read items is the record's, never a value from the request (tenant isolation).

## 4. Routes

| Route | Who | Does |
|---|---|---|
| `GET /api/secretary/feed/{token}` (the `.ics` suffix is optional and stripped) | token only (public) | Validates `^[A-Za-z0-9_-]{43}$`, then the record, then returns `text/calendar; charset=utf-8`. Unknown, malformed, revoked or no-longer-valid: 404, an empty body, no hint which. |
| `GET /api/secretary/feed` | login, `read` | `{ ok, exists, createdAt }`. Never the link. |
| `POST /api/secretary/feed` | login, `read` | Creates or renews; answers `{ ok, url, webcal }` once. |
| `DELETE /api/secretary/feed` | login, `read` | Stops the link. Idempotent. |

- The management routes authenticate first (`currentUser()`), bind to the caller's own login (no id in the URL), and use `allow("sec:feed:{login}", 20, 3600)`.
- A founder impersonating an account cannot create, renew or stop its feed (`IMPERSONATION_BLOCKED`, new action `feed.manage`; minimum role `member`, like `read`).
- The public GET is rate limited before it reads anything but the token's own hash: `allow("feed:ip:{ip}", 120, 3600)` and, once a record exists, `allow("feed:t:{hash}", 60, 3600)` (429 with `Retry-After`). A calendar app polling hourly, even from a shared network, stays under both.
- Response headers: `Cache-Control: private, max-age=300`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, no cookies set.

## 5. Revoking

- Stop and Renew delete the old record at once.
- Wherever an account's MCP token is revoked (password reset, founder reset, account deletion), the feeds of that account's logins are deleted too; removing a member deletes that member's feed; `wipeAccount` deletes every `sec:feedof:*` and `sec:feed:*` it can name from the account's roster (the same way it already names a member's records).
- A member's role change needs nothing: the feed asks only for `read`, which every role has, and the check in section 3 runs on each request.

## 6. Why a secret in a URL is acceptable here, and where it stops

The project rule says secrets are never accepted in URLs. This feed is the one exception, and it is bounded:

- The URL is a read-only capability for one login's view of dated item titles: no notes, no descriptions, no contacts' numbers, no credits, no write.
- It is high-entropy, stored only as a hash, revocable by the login in one press, replaced by renewing.
- It is never logged by our code and never echoed in an error; the server answers 404 without the path. **Residual risk, said plainly:** the platform's own request logs (Vercel) record request paths, so the token appears there. Anyone who can read those logs can read the feed until it is renewed. The page tells the owner to renew the link if it was shared by mistake.
- `permissions.md` records it as a named exception, with these limits.

## 7. Safety of the file itself

- Every text value is escaped per RFC 5545 (backslash, comma, semicolon, new line) after control and direction-override characters are removed (the same cleaning items already get on create). A title can never add a line or a property.
- Lines are folded at 75 octets without splitting a UTF-8 character; lines end with CRLF.
- No item field other than title, due date, all-day flag, direction, party name, `rev` and `updatedAt` is read into the file.
- The file has no price, count, promise or number of ours in it (project rule).

## 8. The page

A card "Subscribe from your calendar" on the calendar page (`/{lang}/app/calendar`), for every role:

- No link yet: one button, "Create my link".
- On creating or renewing: the link and a `webcal://` version once, with Copy buttons, and one sentence per app (iPhone: Settings > Calendar > Accounts > Add subscribed calendar; Google: Other calendars > From URL, which does not accept `webcal://`; Outlook: Add calendar > Subscribe from web). The link disappears when the page is left; after that the card shows "A link exists since {date}" with Renew and Stop.
- A short warning under the link: anyone with it sees your dated task titles; renew it if it was shared by mistake; the calendar app updates on its own schedule, so a change can take a while to appear.
- Text in `app-i18n.ts` (Arabic and English), digits Latin, nothing invented.

## 9. Files

New: `src/lib/secretary-feed.ts` (token, records, validity check, `buildIcs`, escape and fold), `src/app/api/secretary/feed/route.ts`, `src/app/api/secretary/feed/[token]/route.ts`, `src/components/app/FeedCard.tsx`, `tests/secretary-feed.test.ts`. Changed: `src/lib/roles.ts` (`feed.manage`), `src/lib/account.ts` and `src/lib/team.ts` (revocation), the calendar page, `src/lib/app-i18n.ts`, `tests/role-gates.test.ts`, `src/lib/changelog.ts`, `src/lib/help.ts`, and `docs/system/{flows,permissions,architecture,tests,variables}.md` (variables: none new). Rules 530 onward (the plan confirms the numbers are free).

## 10. Tests (one rule each, numbers set in the plan)

1. Token: only the SHA-256 is stored; the plain token is returned once; renewing deletes the old record; `sec:feedof` keeps one per login.
2. Public GET: malformed, unknown, revoked and no-longer-valid logins all give the same empty 404; no store read happens for a malformed token.
3. Tenant isolation: the feed reads only the record's scope; another brand's items never appear; a login moved out of the brand stops working.
4. Content: only open dated items in the window, 500 at most, nearest first; a series shows one copy; no notes, description or contact number anywhere in the body.
5. Times: timed item in UTC with a 30-minute end; all-day item as a date in the brand's zone (a Riyadh item due on 5 October is `20261005`, not the day before).
6. File safety: a title with a comma, semicolon, new line, `BEGIN:VEVENT` and a long Arabic title is escaped, folded at 75 octets without breaking a character, and cannot add a property.
7. Rate limit: IP and token buckets answer 429 with `Retry-After` before any item read; management routes are limited per login.
8. Management routes: 401 anonymous; 200 any role; a founder impersonating gets 403; Stop is idempotent; GET never returns the link.
9. Revocation: password reset, member removal and `wipeAccount` delete the feed keys.
10. Headers: `text/calendar`, `private`, `no-referrer`, `noindex`.
11. UI and copy: both languages carry every new string; the card shows the link once and no number of ours.
12. `role-gates.test.ts` lists both new routes; the route counts in `architecture.md` and `permissions.md` match.

## 11. Rulings made while writing this spec

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| B1-R1 | Hash only, shown once; a lost link is renewed | A leaked store gives no working links; the MCP token keeps plain text today but a calendar link is handed to third-party apps | One extra click for the owner |
| B1-R2 | The link is bound to the brand active at creation | A login with several brands needs a fixed answer; the check in section 3 stops a stale scope | An owner who switches brand renews the link there |
| B1-R3 | Title and a one-line "who acts", no description, no notes | The URL may leak; titles are the least that is useful | Less detail in the calendar app |
| B1-R4 | No `RRULE`, one open copy per series | Reem owns the Hijri and "every N" logic; the calendar cannot | A calendar shows only the next copy, not future ones |
| B1-R5 | Window 14 days back to 365 ahead, 500 events | Bounded file and cost, enough for planning | Items further out are not in the feed |
| B1-R6 | Feed is public GET with the strictest 404 (no oracle) and two rate limits | New public routes need a rate limit | A shared network polling a lot could hit the IP cap and see 429 |
| B1-R7 | Founder impersonation cannot manage a feed | A feed handed out by an impersonator would outlive the session | None meaningful |
| B1-R8 | Vercel path logs are a named residual risk, not fixed | No header-based alternative exists for calendar apps | An attacker with log access reads titles until renewal |
