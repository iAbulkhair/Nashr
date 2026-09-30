# Reem, the secretary — phase 2 (2026-09-30)

Builds on phase 1 (`docs/superpowers/specs/2026-09-29-secretary-reem-phase1.md`, merged in PR #225) and its backlog
from the Taskuary study. Founder decisions of 2026-09-30:

- Timed reminders run on **Upstash QStash** (the Vercel project is on the Hobby plan, whose crons run once a day). A
  QStash schedule calls `POST /api/cron/secretary` every 15 minutes. The founder creates the schedule in the Upstash
  console and adds two environment variables; until then the same sweep runs inside the existing 05:00 UTC daily cron,
  so a reminder is never lost, only late.
- **Telegram is deferred** to a later phase. Nothing in this phase sends outside the app except email.

Everything below is held in code, not in prompts, and keeps phase 1's rules: every key from `sc(u)` (or the bearer's
scope), item ids format-checked, writes under the item lock with `rev`, no `await db.*` inside a loop, free (no credits,
no model call), the owner closes, agents propose.

Updated the same day after an adversarial review of the first commit (33 confirmed findings): the sweep leases instead
of claiming with ZREM and delivers before it writes, the bell has a lock, and the walk, the wrap, the phone number and
handoff notes were tightened. The sections below describe the result.

## 1. Timed reminders

Data:
- `SecItem.remindAt?: string | null`: one reminder instant. Set by the owner in the app, or by an agent (`todo_create`,
  `todo_update` gain `remind_at`, same date rules as `due`, brand zone; a date alone is 08:00 local, which is at or
  before the 05:00 UTC daily run in every Gulf zone, so even the fallback fires it that morning). Must be in the future
  when set (`remind_past`). Cleared by `clear_remind: true` / `remindAt: null`.
- `sec:due:{scope}`: sorted set, member = item id, score = `remindAt` in ms. Maintained ONLY in `indexWrites` (the one
  place every write path goes through): an open item with a `remindAt` is in it at that score; any other item (done,
  deleted, no reminder) is removed. A close, delete, purge or reminder change therefore always cleans it. The sweep
  never removes an id itself: it leaves when the item's write clears `remindAt`.
- `sec:duescopes`: global sorted set, member = scope, score = the earliest `remindAt` of that scope. Updated by
  `indexWrites` (ZADD with the item's score when it is lower than the current one; the sweep recomputes a scope's score
  after it processes it, and removes the scope when its `sec:due` is empty). Account deletion removes the scope member.

`db.ts` gains one sorted-set read on both stores: `zrangeByScore(key, max, limit)` (members with score <= max,
ascending, at most `limit`), and `zadd` takes `{lt: true}` (ZADD LT). (The first commit also had a ZREM claim,
`zremClaim`; the lease below replaced it and it is gone.)

The sweep (`sweepReminders(now, {fromQstash, deadline})` in `src/lib/secretary-remind.ts`). A reminder is late, never
lost:
1. Read up to 200 scopes from `sec:duescopes` with score <= now, grouped by account, 8 accounts at a time. Per account
   read the user and the brand list once: a missing account's scopes leave the index; a suspended account's scopes, and
   those of a brand that is not active (archived), are looked at again 6 hours later with their reminders still due.
2. Per scope (an account's scopes at once, each isolated with `Promise.allSettled`; the zone read falls back to
   Riyadh): read up to 50 due ids from `sec:due:{scope}` with score <= now, and lease each with
   `SET NX sec:firing:{scope}:{id}` for 330 s (longer than the longest caller, the daily cron's 300 s): one run at a time
   works on it. The lease is released when the attempt ends; a killed run's lease expires. The id stays due.
3. For each leased id, under the item lock (30 s): re-read; fire only if the item is open, `remindAt` is set, <= now
   and still the score the sweep read. Delivery first: one in-app notification (`kind: "todo"`, href
   `/{lang}/app/todo`, fingerprint `todo-remind:{scope}:{id}:{remindAt ms}`); then, only when that push was new, one
   email when `RESEND_API_KEY` is set and the scope's email preference is not `none`; then the item: a note of kind
   `reminded` («طلبت تذكيرك اليوم» / "You asked to be reminded"), `remindAt: null`, `rev` bumped (the item first, then
   its index moves, which take the id out of `sec:due`), audit `remind` by actor `cron`. A retry after a crash between
   the delivery and the write finds the fingerprint claimed: no second notification, no second email, and it writes
   the item. If the bell write fails, `pushNotifs` releases the fingerprints it claimed and rethrows, so the retry can
   deliver. An item that is no longer open or has no reminder due leaves `sec:due`; one whose reminder moved is
   re-indexed at its new time.
4. Recompute the scope's score in `sec:duescopes` (earliest remaining, or remove it); a failure is logged, not thrown.
5. A deadline: no account is started and no lease taken after it (the tick passes 40 s after its start, the daily
   route 60 s); what is left stays due. `sendEmail` gives up after 10 s, so a hung send never holds a lease.
6. Write `sec:tick:last` = now (TTL 2 h) when the call came from QStash.

`timedReminders()`: true when `sec:tick:last` is younger than 1 hour. Tool answers and the page say "at {time}" only
then; otherwise they say the reminder arrives with the next morning brief after that time, at the brief's local time in
the brand's zone (05:00 UTC plus the zone's offset: 08:00 in Riyadh, Kuwait, Doha and Manama, 09:00 in Dubai and
Muscat; never a fixed "08:00"). Never promise what is not running.

Route `POST /api/cron/secretary` (`maxDuration = 60`):
- Accepts a QStash call: header `Upstash-Signature` verified in `src/lib/qstash.ts` without a new dependency: a JWT HS256
  signed with `QSTASH_CURRENT_SIGNING_KEY` or `QSTASH_NEXT_SIGNING_KEY` (HMAC-SHA256 over `header.payload`, compared in
  constant time); `iss` is `Upstash`; `sub` ends with `/api/cron/secretary`; `nbf <= now <= exp` (30 s leeway); `body`
  equals base64url(SHA-256(raw body)) with padding stripped. Any failure is 401 and nothing runs.
- Or `Authorization: Bearer {CRON_SECRET}` compared with `sameSecret` (for manual runs and tests).
- Oversized input is refused first, unread: a body over 64 KB (413), a signature header over 4096 characters (401).
- Only failed calls count against the per-IP limit (`allow`, 60 a minute, then 429): a verified call is never counted,
  so strangers sharing QStash's egress addresses cannot fill the bucket and block the real tick.
- Runs `sweepReminders`, then the evening pass (section 5) when due. Returns counts only.
- The daily cron (`/api/cron/daily`) also runs the sweep on its first hop, before the per-workspace batch: again while a
  sweep read a full 200 scopes (at most 4 more times, within 60 s of the route's start), and the time it took comes out
  of the batch's 240 s start budget.

New environment variables (docs/system/variables.md): `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`. Without
them the QStash path is refused (401) and the daily fallback still works.

Snooze presets gain `nextweek`: 09:00 local on the first working day of next week in the brand's zone (Sunday; Monday
in the UAE: `weekStart`). The page offers it next to 2h / tonight / tomorrow.

## 2. One close path, and reopen

- `indexWrites` stays the only index writer and now covers `sec:due` and `sec:duescopes`. A test drives every way an
  item can close (complete, confirm_done, closeLinked, delete, purge) and asserts no `sec:due` member remains.
- New owner-only action `reopen` (`OWNER_ONLY`, route role `todo.close`): a done item becomes open again, `completedAt`
  and `result` cleared, a note of kind `reopened`; it counts against the open cap. The page's "recently done" rows get
  a Reopen button for the owner and admins. Chat and MCP cannot reopen.

## 3. Following up on WhatsApp without sending anything

- `SecItem.phone?: string | null` on a they-owe item: the contact's WhatsApp number in the international form wa.me
  needs. Cleaning makes Arabic-Indic (U+0660-0669) and Eastern Arabic (U+06F0-06F9) digits ASCII and removes `+`,
  spaces, dashes, dots, parentheses and one leading "00"; then it must be 8 to 15 digits with no leading zero
  (`^[1-9]\d{7,14}$`), else `bad_phone` («اكتب الرقم مع رمز الدولة، مثل 9665…» / "Enter the number with the country
  code, e.g. 9665…"). No country code is guessed. Set by the owner in the app only (the add form and the edit on a
  row); chat and MCP never read or write it and it never appears in a tool answer or a prompt. When someone else comes
  to owe the item (a change of `owedBy`, by anyone), the old party's number is dropped unless the owner gives the new
  one in the same change.
- The row of a they-owe item with a phone shows a WhatsApp link: `https://wa.me/{digits}?text={message}`, the message a
  fixed template in the page language («السلام عليكم {name}، أتابع معك بخصوص: {title}. شكراً لك.» / "Hi {name}, following
  up on: {title}. Thank you."), filled in one pass (`fill`), so what someone typed is inserted as typed. Tapping it also records the follow-up (`chased`, fired with `keepalive`), so the chase
  clock restarts and the note says «تمت المتابعة», never "sent". Nothing is sent by the app.

## 4. "Walk me through my to-dos"

- `walkNext(scope, now, opts)` in `src/lib/secretary-walk.ts` returns ONE card, built in code, no model: the first item
  not skipped in this order: needs confirmation, overdue, due today, time to chase, then inbox items waiting for approval,
  oldest first. Skipped cards are left out before the cut to 50; past 50 candidates the oldest are chosen by the inbox
  list's creation order (`tasks:{scope}`, ids only), then one MGET of those 50; `left` counts every candidate. A card:
  `{key, kind: "todo" | "approval", id, title, line, actions}`, plus, on a confirm card, the agent's `claim` (marked
  unchecked) and the app's `fact` about the linked inbox item, and on an approval card the draft's first 500 characters
  (`excerpt`) and, when the brand guard holds it (`gateTask`, as the inbox's PATCH checks), why (`held`) with no
  approve action. `actions` come from a fixed table per card kind and bucket, and only actions the viewer may take
  (`todo.close` for done/confirm/reject, `publish` for approve).
- Next skips a card for 3 hours: `sec:walk:{scope}` holds `{key: untilMs}` (one JSON value, TTL 1 day, stale entries
  dropped on write).
- Routes: `GET /api/secretary/walk` (member, `read`) → `{card, left}`; `POST /api/secretary/walk {action: "next", key}`
  (member, `todo.write`) → the next card. The card's other actions call the existing routes (`/api/secretary/{id}`,
  `/api/tasks/{id}`), so every gate stays where it is.
- The to-do page gets a "Walk me through" button that shows one card at a time with its buttons and a Next button.
- Chat and MCP tool `agenda_next {skip_id?}`: the next card as a tool line (and skips `skip_id` for 3 hours first).
  Done, confirm, not yet, approve and open are the owner's; on a to-do card the agent may snooze it or record the
  owner's follow-up with `todo_update` when the owner asks, and the line says so.

## 5. Evening wrap

- Built in code in `src/lib/secretary-evening.ts` from stored facts only, after the agenda (`agendaFor`) closed the
  items whose linked inbox item was approved: items completed today (local day) with their result, approvals (approve,
  and publish, which approves) and rejections the owner decided today (from `decisions:{scope}`), items that fell
  overdue since the previous evening's wrap time (yesterday's 18:00, or 21:30 in Ramadan; an all-day item due yesterday
  included), and the first three items the agenda would show at 09:00 tomorrow. No model, no motivational line.
- Silent when all four are empty. Sent once per scope per local day: marker `sec:wrap:{scope}:{day}` claimed with
  `setNx` (TTL 2 days), released when the in-app notification cannot be written, so the batch's retry can send it.
- Delivered as one in-app notification (`kind: "todo"`), and one email when `RESEND_API_KEY` is set and the email
  preference is `all`. With more than one active brand, the title and the email's subject name the brand.
- Off when the owner switched follow-ups off in Scheduled tasks; that switch's text says it silences the wrap too.
- When: 18:00 local; during Ramadan (`activeSeasons()` has `ramadan`) 21:30 local, after Taraweeh.
  - A new Vercel daily cron `/api/cron/evening` at `0 15 * * *` (18:00 Riyadh, 19:00 Dubai) runs the wrap for every
    workspace outside Ramadan, through `runCronBatch` like the daily job.
  - The QStash tick runs the wrap for the scopes of a zone when that zone's target time fell within the last 15 minutes;
    in Ramadan only this path sends (without QStash, no wrap in Ramadan; documented).

## 6. A blocked agent opens a waiting-on item

- New chat tool for every agent: `handoff_note {to: agent id | "owner", kind: "blocked" | "ready" | "note", body}`
  (body up to 500 characters). Notes are stored in the capped list `notes:{scope}` (last 30, TTL none, removed with the
  account). The receiving agent sees its last 5 notes from the past 7 days in its volatile prompt block, serialised with
  `asData` inside `<handoff_notes>` and labelled as data.
- `kind: "blocked"` also creates a Reem item in code (source `agent`): to "owner" → the owner owes the agent input
  (i_owe, owedTo the agent, kind `follow_up`), due all day today in the brand's zone, so it reaches today's agenda, the
  brief, the wrap and the walk; to another agent → that agent owes it (they_owe, owedBy that agent, kind `waiting_on`,
  with the usual chase date). The tool answer is built from the stored item and says it is in the morning brief only
  when it is. Title «توقّف عمل {agent}: {body}» / "{agent} is blocked: {body}" (cleaned, 200 characters; the Arabic
  reads the same whatever the grammatical gender of the agent's name). At most 20 blocked notes a day per account
  (`allow`).
- Before opening that item, the brand's open items are checked, under one lock per scope: an open item the same agent
  opened for the same party (source `agent`, `handoffFrom` = that agent, same direction and party) whose text says the
  same thing gets the new body as a note instead of a second item, and the tool answer says so. "The same thing"
  (`sameBlock`): the two equal after normalising (controls removed, lower case, Arabic diacritics and tatweel removed,
  punctuation to spaces); otherwise both at least 3 words, `similarity` from `src/lib/similarity.ts` (word-bigram
  Dice) >= 0.6 AND at most 2 words in one and not the other. Agents write in templates: "send the April sales numbers"
  and "send the new logo files" share the frame and are not the same request. `similarity` of two texts with no
  bigram (one word each) is 1 only when they are the same words. The repo had no threshold for it elsewhere
  (`editPctOf` only measures edits), so 0.6 is new here.
- Not available over MCP.

## Out of scope (phase 3 and later)

Telegram doorway; WhatsApp utility templates (legal review first); `awayUntil` per contact and quiet days (Eid,
Ramadan windows, the brand's weekend) for chasing; voice notes; recurring items; Google Calendar sync.

## Tests and docs

Every rule above gets a test (next free numbers after 220 in `docs/system/tests.md`), including: overlapping sweeps fire
once; a reminder on a closed or deleted item never fires; no close path leaves `sec:due`; the QStash verifier refuses a
wrong key, a wrong `sub`, an expired token and a changed body, and accepts the next key; the evening wrap is silent when
nothing happened and sends once; walk skip lasts 3 hours and never offers an action the viewer lacks; a blocked note to
the owner creates exactly one item; phone never reaches a tool answer or prompt. Update `docs/system/architecture.md`
(modules, keys), `flows.md` (a section per part), `permissions.md` (new routes and roles, role-gates map), `variables.md`
(the two QStash keys), `tests.md`, and `vercel.json` (the evening cron).
