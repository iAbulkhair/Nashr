# Reem phase 3 B2: bookings in (B2a) and the follow-up after the meeting (B2b)

Status: draft for the founder's review, 2026-10-05. Part B of phase 3 (see `2026-10-02-secretary-reem-phase3a-design.md`); B1 (the calendar feed) is merged, B3 (Google and Outlook busy times) is a separate spec. B2a and B2b share this spec and ship as two pull requests, B2a first, because B2b works on the meeting items B2a creates.

## 1. Goal and what the founder decided

A customer books through Calendly or Cal.com. Reem puts the meeting on the owner's list. After the meeting she asks what came out of it, turns the answer into proposed tasks, the owner approves them, and each approved task goes to the Thakeen agent whose job it is.

Decided by the founder on 2026-10-05:

- **Calendly and Cal.com both**, in B2a. Cal.com: the owner pastes a link and a key into Cal.com. Calendly: the owner pastes a personal access token once; Thakeen creates the webhook on their behalf and forgets the token (it is never stored).
- **"The team" means the Thakeen agents** (`AGENT_IDS`), not human members. A task goes to an agent as an item the agent owes (`they_owe`), the path `blocked` handoffs already use. Assigning to human members needs a job-role field the product does not have; it is a later project.
- **Outcome comes from the owner**, two ways: typed notes (in Reem's chat or on the meeting item), or a pasted or loaded transcript text. The provider sends no notes. Transcripts cost credits, shown before and charged before the model runs.
- **Nothing becomes a task without the owner's approval**, checked in code.

Not in B2: reading a transcript straight from Fireflies, Otter, Zoom or Meet (a later, provider-specific spec), human-member assignment, the attendee's email or phone, any message to the attendee, follow-up for meetings that did not come from a booking, voice notes.

## 2. B2a: what a booking becomes

One open item per booking, in the link's brand scope:

- `kind: "task"`, `direction: "i_owe"`, `source: "booking"` (new value of `SecSource`, B2-R1), title "Meeting with {attendee name}" (Arabic: "اجتماع مع {الاسم}"; the link's language), `description` the event-type name and "booked via Calendly/Cal.com", `owedTo` the attendee's name (cleaned, 80 characters).
- Timed: `dueAt` is the start instant, converted to the brand zone's local time before `createItem` (Gulf zones are fixed offsets), `allDay: false`. `remindAt` is the end instant when still in the future, so the existing 15-minute sweep (`sweepReminders`) rings the bell once (its wording is the sweep's own; the plan checks it and, if it reads badly for a meeting, gives booking items their own line), which is the follow-up prompt. The item itself is the thing the owner opens to give the outcome (section 5).
- **Not stored:** the attendee's email, phone, notes they typed at booking, the video link, the cancellation reason. Only name, event-type name, start, end, the provider and the booking's external id. The item then reaches the B1 feed, the morning brief and agents without new personal data.
- Booking in the past by more than one day, or more than 366 days ahead: ignored, answered 200.
- Created through `createItem(user, fields, { actor: "rule", via: "cron", source: "booking" })` for the owner's account (the record's scope, never the request's). A new per-link limiter, `allow("book:new:{hash}", 60, 86400)`, caps creations so a leaked link cannot spend the owner's 200 a day (`SEC_CREATE_PER_DAY`) or fill the 500 open cap (`SEC_OPEN_MAX`); both existing limits stay as the backstop.

Cancel and reschedule (the provider field names are confirmed against each provider's current documentation in the plan's first task, and the parsers are pure functions with fixture tests):

| Provider event | Does |
|---|---|
| Cal.com `BOOKING_CREATED` | Create (or no-op when the booking id is known). |
| Cal.com `BOOKING_RESCHEDULED` | Move the same item to the new start and end (`changeItem` `reschedule`), re-arm `remindAt`; unknown id creates it. |
| Cal.com `BOOKING_CANCELLED` | Remove the item (section 3 helper). |
| Calendly `invitee.created` | Create; when it names an old invitee (a reschedule), move that invitee's item instead and map the new invitee to it. |
| Calendly `invitee.canceled` | Remove the item, unless it says it is a reschedule, in which case do nothing (the matching `invitee.created` owns the move; arrival order is not guaranteed). |
| Anything else with a valid signature | Answer 200, do nothing (the sender must not retry or disable the hook). |

Idempotency: a claim `sec:book:ext:{scope}:{provider}:{externalId}` set with `SET NX`, value the item id, TTL 400 days, under the item's lock. A replayed create is a no-op; a cancel or reschedule finds its item through the claim; a claim older than its TTL is treated as unknown (a cancel is ignored, a reschedule creates). The key is added to `secretaryKeys` so account deletion removes it.

## 3. B2a: the link, the signature and the routes

Records, shaped like B1's (`src/lib/feed-token.ts`, which this reuses where it can):

- Token: 32 random bytes, base64url, 43 characters, shown once; only its SHA-256 is stored.
- `sec:book:{hash}` → `{ login, scope, provider: "calcom" | "calendly", lang, createdAt }`; `sec:bookof:{login}:{provider}` → the current hash (one link per login per provider; a record not named by it is dead); lock `lock:book:{login}:{provider}`.
- **Signing key:** `HMAC-SHA256(CONNECT_SECRET, "booking:v1:" + hash)`, derived on demand and never stored (B2-R3). It is shown once, at creation, as a hex string. `CONNECT_SECRET` is the existing at-rest key (production refuses to start without it); no new environment variable. Rotating it ends every booking link, and every connector connection already, so the owner recreates them.
- A booking link has no stored secret, so a leaked store gives no way to forge a booking. A leaked URL alone (Vercel request logs, section 7) also cannot forge one: every request needs a valid signature.

| Route | Who | Does |
|---|---|---|
| `POST /api/secretary/booking/{token}` | token plus signature (public) | The webhook (check order below). |
| `GET /api/secretary/booking` | login, `read` | `{ ok, links: [{ provider, createdAt, sameBrand }] }`, never the link, key, hash or scope. Own bucket `sec:read:{login}`. |
| `POST /api/secretary/booking` | login, `booking.manage` | Body `{ provider: "calcom", lang? }` answers `{ ok, url, secret }` once. Body `{ provider: "calendly", token: "<personal access token>" }` creates the Calendly webhook and answers `{ ok }` (below). Replaces any earlier link of that provider. 409 `busy` when the lock is held. Bucket `sec:book:{login}`, 20 an hour. |
| `DELETE /api/secretary/booking?provider=` | login, `booking.manage` | Stops that provider's link. Idempotent. |

New action `booking.manage`: minimum role `member`, in `IMPERSONATION_BLOCKED` (a link and a key handed out by an impersonator would outlive the session). The URL origin is `appOrigin()`, never the request's.

**Webhook check order**, the same discipline as B1 with the signature added:

1. Read the body with a 64 KB cap (`readCapped`), before parsing; over the cap, empty 404.
2. Token shape `^[A-Za-z0-9_-]{43}$`, else empty 404 (no store read).
3. `resolveBook(token)` (record exists and is named by `bookof`), else empty 404.
4. On a miss only (step 3 found no live record): `allow("book:ip:{ip}", 1200, 3600)`, the answer the same empty 404 over the count or not. Amended 2026-10-05 (B2-R6, final review I-1): the bucket was first charged before step 3, for every request; the providers deliver every customer's webhooks from a few shared addresses, so one party (a stranger with their own provider account, or an orphaned Calendly subscription) could exhaust it and get every customer of that provider refused for the hour, losing bookings. A live link is now limited only by step 5 and the per-link creation cap.
5. `allow("book:t:{hash}", 120, 3600)`, 429 with `Retry-After`.
6. `bookHolds(rec)`: the same checks as `feedHolds` (login active, scope belongs to the owner, brand active, record not older than the login's life or the session stamps; B1-R11, R14, R15), made into one shared function. Failure is the same empty 404.
7. Verify the signature over the raw body, with `sameSecret`: Cal.com `x-cal-signature-256` is the hex HMAC-SHA256 of the body; Calendly `Calendly-Webhook-Signature` is `t=<unix>,v1=<hex>` where `v1` is the hex HMAC-SHA256 of `{t}.{body}`, and `t` must be within 5 minutes of now (B2-R4). A bad or missing signature is the same empty 404 (no oracle).
8. Parse JSON; a malformed body answers 400 (the sender is authenticated, so no oracle is lost). Parse into the neutral shape `{ kind: "create" | "move" | "cancel" | "ignore", externalId, oldExternalId?, name, eventName, start, end }`, bounding and cleaning every string (`cleanLine`; controls and direction overrides removed).
9. Act under the item lock (section 2). Answers: 200 when handled or ignored; 503 when the lock is held or storage fails, so the provider retries; 500 for a corrupt record, on purpose.

The route authenticates by token and signature, not by session, and reads and writes with `rec.scope` only.

**Calendly setup** (`POST` with `provider: "calendly"`): with the pasted token, `safeFetch` (https only) calls `GET https://api.calendly.com/users/me`, then `POST https://api.calendly.com/webhook_subscriptions` with our URL, events `invitee.created` and `invitee.canceled`, `scope: "user"`, and our derived signing key as `signing_key`. The token is held in memory for these calls only: never stored, never logged, never echoed in an error, never part of a URL, length-limited (2,000), and the request is dropped from any log. If the subscription fails, the freshly written record is deleted and the answer is a typed error (`calendly_rejected`, `calendly_plan`: webhook subscriptions need a Standard plan or higher, verified 2026-10-05). The plan task re-checks `signing_key` against the current Calendly docs before coding.

**Removing the item on cancel** needs a system-side delete: `OWNER_ONLY` refuses `delete` from anything but the owner on the web, and the only system precedent is the private `deleteNextCopy`. The plan extracts it into one exported helper (`removeBySystem(scope, id, actor)`: lock, `deletedAt`, `expiresAt` +30 days, rev, `indexWrites`, `audit`), and `deleteNextCopy` calls it, so the restore window and the audit line stay identical (B2-R7).

**Revoking:** Stop and Renew delete the old record. The places that call `revokeFeeds` today (owner reset, founder reset, `dropMember`, `wipeTeam`, `wipeAccount`) also revoke booking links, by the same rules as B1-R12 (an owner's password reset revokes the owner's and every roster member's; a password change only the owner's; a member's own events only theirs). Calendly keeps the stopped subscription on its side, answered 404 until it disables it; the card says so.

## 4. B2a: the page

A card "Bookings" on My to-dos (`TodoPanel`, below the feed card), every role, B1-R9 reasoning (these are Reem's items):

- Two rows, Cal.com and Calendly. Not connected: a button "Connect".
- Cal.com: the URL and the signing key once, with Copy, and the three steps ("Cal.com > Settings > Developer > Webhooks > New: paste the URL, paste the key as the secret, tick Booking created, Booking cancelled and Booking rescheduled"). After the page is left: "Connected since {date}" with Renew and Stop.
- Calendly: a field for the personal access token, one sentence "used once to set the connection up, never saved", and the plan note (Standard or higher). On success the field clears and the row shows "Connected since {date}".
- Warning: anyone with a Cal.com link and its key can add meetings to your list; stop it if it was shared by mistake.
- Text in `app-i18n.ts`, both languages, digits Latin, nothing invented.

## 5. B2b: the follow-up

Applies only to `source: "booking"` items in the caller's scope.

**Three ways in, one store.** Each ends in a pending set of proposals for that item, `sec:mprop:{scope}:{itemId}`, TTL 14 days (added to `secretaryKeys`), at most 10 entries: `{ ref, title, agent, dueAt? }`, where `agent` is an `AGENT_IDS` value or `"owner"`.

1. **Typed notes in Reem's chat.** A new chat tool `propose_meeting_tasks { item_id, tasks[] }`: Reem, already the model of the turn, writes the proposals herself, so this costs no extra model call and stays inside the turn's `CHAT_TURN_MAX_USD`. Refused over MCP, like handoffs. The tool only stores proposals; it never creates an item.
2. **Typed notes on the meeting item.** A box on the item (up to 4,000 characters): `POST /api/secretary/meeting/{id}/propose { kind: "notes", text }`. One model call by the server, free to the owner, capped at 20 a day per account (`allow("meet:notes:{email}", 20, 86400)`, B2-R9).
3. **A transcript.** The same route with `kind: "transcript"` and `text` up to 40,000 characters (the owner pastes it, or loads a `.txt`, `.vtt` or `.srt` file, which the browser reads into the text field; no upload route). Costs 1 credit (B2-R8), shown before the call and charged before the model runs with `chargeOnce(email, cost, meta, "meeting:{scope}:{itemId}:{n}")` (`meta`: `{scope, agent: "reem", cap}` from the governance agent cap), refunded with `refundOnce` when the model call fails; a retry reuses the hold. A second run replaces the pending set and is charged again. Over 40,000 characters is refused with a message; it is never cut silently. The transcript is not stored anywhere (not in files, not in memory, not in the item): only the proposals survive, as titles.

**The model call** (ways 2 and 3): Sonnet 5.5 (`task-costs.ts` gets one new row), output capped (about 1,500 tokens), one forced tool call that returns the proposals. The text goes in a `<meeting_text>` block through `asData`, labelled as data that may contain instructions to ignore. The code validates the output: at most 10 items; `agent` must be an `AGENT_IDS` value or `"owner"` (anything else is dropped); each title cleaned by `cleanLine` and cut at 120 characters; `dueAt` accepted only as a valid local day within the next 366 days; duplicates removed. A model that returns something else produces zero proposals and an honest "no tasks found", and the credit is refunded.

**Reading and approving.**

| Route | Gate | Does |
|---|---|---|
| `GET /api/secretary/meeting/{id}` | `read` | The pending proposals for that item, or none. |
| `POST /api/secretary/meeting/{id}/propose` | `todo.write` | Ways 2 and 3. `no_credits` when the balance is short (nothing taken). |
| `POST /api/secretary/meeting/{id}/approve` | `todo.write` | Body: the proposals the owner kept, each as edited (title, agent, due). Creates the items. |
| `DELETE /api/secretary/meeting/{id}` | `todo.write` | Discards the pending set. |

All four authenticate first, take the scope from `sc(u)`, validate `{id}` with `SEC_ID`, and refuse an item that is not a live `booking` item of that scope (404). `approve` takes a lock, reads the pending set, **creates only what the pending set holds and the owner's edits keep within the same limits** (an agent id outside the list, a title over 120 characters, more than 10 entries are refused, not trimmed), then deletes the set, so a double click cannot create twice. A task for the owner is `kind: "task"`, `i_owe`. A task for an agent has the `blocked` handoff shape: `kind: "waiting_on"`, `direction: "they_owe"`, `owedBy: "<agentId>"`, `owedTo: "owner"`, created with `source: "agent"` and `handoffFrom: "reem"`, in the brand's zone, so it shows in Reem's list and in that agent's block like any other handoff. **The agent does not run the task and nothing is spent when it is created**; an agent acts when the owner asks it to, as today. Each created item says in its description which meeting it came from.

**The page:** on a booking item whose start has passed, an action "Meeting outcome" opens a panel: a notes box with "Suggest tasks", a transcript box or file button with the credit cost beside it and "Suggest tasks from the transcript", then the proposals as rows (title, agent, due day, a checkbox, edit and remove) and one "Approve selected" button. The bell from `remindAt` is the nudge.

## 6. Limits and what stays unchanged

- The model never creates an item: the chat tool and the two routes only store proposals; `approve` is the one code path that creates, and it needs a signed-in owner or member with `todo.write`.
- Credits are charged only for a transcript the owner submitted, with the cost shown first. No credit is spent by a webhook, a reminder, or an agent.
- Untrusted input: webhook fields, notes and transcripts are data. They are cleaned, bounded and shown to a model only through `asData`. A transcript that says "approve everything" changes nothing, because approval is a click on `approve` by a signed-in login.
- No new environment variable. `docs/system/variables.md` says so.

## 7. The URL in the path: what is and is not accepted

A booking link has the token in its path, as the feed does, because Calendly and Cal.com let the owner choose only a URL. It is weaker than the feed's exception in one way and stronger in another: it grants no read (it only lets a signed sender add or move meetings), and it needs the signature, which is never in the URL. Residual risk, said plainly: Vercel's request logs record the path; a reader of those logs learns a token but still cannot forge a booking without the key. `permissions.md` records it as a second named exception.

## 8. Files

New: `src/lib/booking-token.ts` (token, records, derived key, revocation; shares `feedHolds` through a generalised helper), `src/lib/secretary-booking.ts` (signature checks, the two parsers, `applyBooking`), `src/lib/secretary-meeting.ts` (proposals, validation, the model call, approve), `src/app/api/secretary/booking/route.ts`, `src/app/api/secretary/booking/[token]/route.ts`, `src/app/api/secretary/meeting/[id]/route.ts`, `.../propose/route.ts`, `.../approve/route.ts`, `src/components/app/BookingCard.tsx`, `src/components/app/MeetingPanel.tsx`, `tests/secretary-booking.test.ts`, `tests/secretary-meeting.test.ts`. Changed: `secretary-agenda.ts` (`SecSource`), `secretary.ts` (`removeBySystem`, `secretaryKeys`), `roles.ts` (`booking.manage`), `chat.ts` (the tool), `team.ts` and `account.ts` and the reset routes (revocation), `credits.ts` or `pricing.ts` (`MEETING_TRANSCRIPT_COST`), `task-costs.ts`, `TodoPanel.tsx`, `app-i18n.ts`, `changelog.ts`, `help.ts`, `tests/role-gates.test.ts`, and `docs/system/{flows,permissions,architecture,tests,variables,costs}.md`. Rules 586 onward (the plan confirms the numbers are free).

## 9. Tests (one rule each, numbers set in the plan)

B2a:
1. Token: only the hash is stored; shown once; renewing deletes the old record; one link per login per provider.
2. Public route: malformed token, unknown, revoked, no-longer-valid login and bad signature all give the same empty 404; no store read for a malformed token; body over 64 KB is refused before parsing.
3. Signatures: Cal.com and Calendly vectors verify; a changed body, a wrong key, a stale Calendly timestamp and a missing header fail; comparison is constant time (`sameSecret`).
4. Create, move and cancel for both providers from fixtures; Calendly reschedule in both arrival orders; a replayed create makes one item; an unknown id on cancel is a 200 no-op.
5. Item content: no email, phone, link or notes anywhere in the item; times converted to the brand zone; `remindAt` set only when future; past and far-future bookings ignored.
6. Tenant isolation: the item goes to `rec.scope` only; a login moved out of the brand stops working.
7. Limits: per-link creation cap, IP and link request buckets (429 with `Retry-After`), management routes per login; the owner's 200 a day is not spent past the link cap.
8. Management routes: 401 anonymous, 200 any role, 403 under impersonation, Stop idempotent, GET never returns link or key; Calendly: the token is never stored, logged or echoed, and a rejected subscription leaves no record.
9. Revocation: resets, member removal and `wipeAccount` delete booking records and claims.
10. `removeBySystem`: same restore window and audit as before; `deleteNextCopy` behaviour unchanged.

B2b:
11. Chat tool stores proposals only, never an item; refused over MCP; unknown agent id dropped.
12. Validation: more than 10, a long title, a bad day, duplicates, a non-list agent are dropped or refused as specified.
13. Credits: 1 credit before the model for a transcript, refunded on failure, reused on retry, charged again on re-run; notes cost none and stop at 20 a day; over 40,000 characters refused with nothing charged.
14. Injection: a transcript that orders approval or another agent changes no output field outside the schema; the text appears in the prompt only inside `asData`.
15. Approve: only the pending set is created; edits outside the limits are refused; a double approve creates once; tasks for agents have the handoff shape and `source: "agent"`; nothing is spent.
16. Tenant and gates: 401, `todo.write` for propose, approve and delete; another scope's item id is 404.
17. UI and copy: both languages carry every new string; the card shows the key once; the cost is shown before a transcript is sent.
18. `role-gates.test.ts` lists every new route; the counts in `architecture.md` and `permissions.md` match.

## 10. Rulings made while writing this spec

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| B2-R1 | New `SecSource` value `booking` | No existing value means "came from a webhook"; the meeting action must find these items without a new field | One union member and the places that switch on source (the plan lists them) |
| B2-R2 | One item per booking, with `remindAt` at the end instead of a second follow-up item | The existing sweep already fires once, the list stays short, and the feed shows one event | The nudge is the generic reminder text, not "what came out of it?" |
| B2-R3 | Signing key derived from `CONNECT_SECRET` and the link hash, not stored and not a new variable | Nothing to leak from a store; no new variable | Rotating `CONNECT_SECRET` ends all booking links |
| B2-R4 | Calendly timestamp window of 5 minutes; Cal.com has no timestamp, so a replay is absorbed by idempotency | Cal.com signs the body only; replays of create, move and cancel are harmless by design | A captured Cal.com body replayed with its old content changes nothing new |
| B2-R5 | Only name, event-type name, start, end and the provider's booking id are kept | Data minimisation; the item reaches the feed and agents | The attendee's email is not in the item |
| B2-R6 | Webhook IP count 1,200 an hour (feed: 120), charged only on a miss and never refusing a live link (amended 2026-10-05, final review I-1; first written as a cap charged before the record read) | The two providers deliver all customers' webhooks from a few shared addresses, so a cap charged on every request let one party refuse every customer of a provider for the hour | A miss over the count is the same empty 404, so the count limits nothing a caller sees; a live link is limited by its own 120 an hour |
| B2-R7 | One exported `removeBySystem` shared with `deleteNextCopy` | `OWNER_ONLY` forbids system deletes; copying the logic would let the restore window drift | A small refactor of the series code in B2a |
| B2-R8 | Transcript cost: a flat 1 credit up to 40,000 characters (the limit `writeFile` also uses) | 40,000 characters is about 16,000 tokens at 2 characters per token: about $0.05 on Sonnet 5.5 against about $0.06 per credit at the floor (`maxCostPerCreditUsd`); the plan's first task measures a real Arabic transcript and sets 2 credits if it does not fit | If measured higher, the cost becomes 2 credits |
| B2-R9 | Typed notes are free, capped at 20 a day; the chat route costs nothing extra (Reem writes the proposals inside her turn) | About $0.01 a call; the chat turn is already budgeted | At 20 a day a busy account pays nothing for up to 20 note runs |
| B2-R10 | Transcript text and notes are never stored; only the proposals (titles) are, for 14 days | A transcript holds third parties' words and may hold secrets | A lost proposal set means pasting again |
| B2-R11 | Follow-up works only on `booking` items | Keeps the tenant and gate surface small; meetings made by hand are a later extension | The owner cannot run it on a hand-made meeting item |
| B2-R12 | A task for an agent is created, not run; no credit moves at approval | "Spending credits outside a user request" is checked in code; approval is a request to track, not to execute | Agents still need the owner to ask them |
| B2-R13 | Assignment to human members is out of scope | Roles today are permissions only (`owner`, `admin`, `member`), not job roles | A later project needs a role field and a per-item assignee |
| B2-R14 | A Calendly token is used once and never stored, so Stop removes only our side | Holding a user's Calendly token at rest is a larger secret than the feature needs | A stopped Calendly subscription stays on Calendly until it disables itself; the card says so |
