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

## 1. Timed reminders

Data:
- `SecItem.remindAt?: string | null`: one reminder instant. Set by the owner in the app, or by an agent (`todo_create`,
  `todo_update` gain `remind_at`, same date rules as `due`, brand zone). Must be in the future when set (`remind_past`).
  Cleared by `clear_remind: true` / `remindAt: null`.
- `sec:due:{scope}`: sorted set, member = item id, score = `remindAt` in ms. Maintained ONLY in `indexWrites` (the one
  place every write path goes through): an open item with a `remindAt` is in it at that score; any other item (done,
  deleted, no reminder) is removed. A close, delete, purge or reminder change therefore always cleans it.
- `sec:duescopes`: global sorted set, member = scope, score = the earliest `remindAt` of that scope. Updated by
  `indexWrites` (ZADD with the item's score when it is lower than the current one; the sweep recomputes a scope's score
  after it processes it, and removes the scope when its `sec:due` is empty). Account deletion removes the scope member.

`db.ts` gains two sorted-set commands on both stores: `zrangeByScore(key, max, limit)` (members with score <= max,
ascending, at most `limit`) and `zremClaim(key, member): Promise<boolean>` (ZREM, true only when this call removed it).

The sweep (`sweepReminders(now)` in `src/lib/secretary-remind.ts`):
1. Read up to 200 scopes from `sec:duescopes` with score <= now.
2. For each scope (via `pmap`, concurrency 8): read up to 50 due ids from `sec:due:{scope}` with score <= now, then claim
   each with `zremClaim` (only the run that removed it fires it; overlapping runs never double-fire).
3. For each claimed id, under the item lock: re-read; fire only if the item is open, `remindAt` is set and <= now.
   Firing = add a note of kind `reminded` («طلبت تذكيرك اليوم» / "You asked to be reminded"), set `remindAt: null`,
   bump `rev`, audit `remind` by actor `cron`. Then one in-app notification (`kind: "todo"`, href `/{lang}/app/todo`,
   fingerprint `todo-remind:{scope}:{id}:{remindAt ms}`, so a retry never repeats it) and, when `RESEND_API_KEY` is set
   and the account's email preference is not `none`, one email.
4. Recompute the scope's score in `sec:duescopes` (earliest remaining, or remove it).
5. Write `sec:tick:last` = now (TTL 2 h) when the call came from QStash.

`timedReminders()`: true when `sec:tick:last` is younger than 1 hour. Tool answers and the page say "at {time}" only
then; otherwise they say the reminder arrives "by the next morning brief (08:00)". Never promise what is not running.

Route `POST /api/cron/secretary` (`maxDuration = 60`):
- Accepts a QStash call: header `Upstash-Signature` verified in `src/lib/qstash.ts` without a new dependency: a JWT HS256
  signed with `QSTASH_CURRENT_SIGNING_KEY` or `QSTASH_NEXT_SIGNING_KEY` (HMAC-SHA256 over `header.payload`, compared in
  constant time); `iss` is `Upstash`; `sub` ends with `/api/cron/secretary`; `nbf <= now <= exp` (30 s leeway); `body`
  equals base64url(SHA-256(raw body)) with padding stripped. Any failure is 401 and nothing runs.
- Or `Authorization: Bearer {CRON_SECRET}` compared with `sameSecret` (for manual runs and tests).
- Rate limited per IP (`allow`, 60 a minute) before verification.
- Runs `sweepReminders`, then the evening pass (section 5) when due. Returns counts only.
- The daily cron (`/api/cron/daily`) also calls `sweepReminders` once per run, before the per-workspace batch.

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

- `SecItem.phone?: string | null` on a they-owe item: the contact's WhatsApp number, digits only after cleaning
  (`+`, spaces, dashes removed), 8 to 15 digits, else `bad_phone`. Set by the owner in the app only (the add form and
  the edit on a row); chat and MCP never read or write it and it never appears in a tool answer or a prompt.
- The row of a they-owe item with a phone shows a WhatsApp link: `https://wa.me/{digits}?text={message}`, the message a
  fixed template in the page language («السلام عليكم {name}، أتابع معك بخصوص: {title}. شكراً لك.» / "Hi {name}, following
  up on: {title}. Thank you."). Tapping it also records the follow-up (`chased`, fired with `keepalive`), so the chase
  clock restarts and the note says «تمت المتابعة», never "sent". Nothing is sent by the app.

## 4. "Walk me through my to-dos"

- `walkNext(scope, now, opts)` in `src/lib/secretary-walk.ts` returns ONE card, built in code, no model: the first item
  not skipped in this order: needs confirmation, overdue, due today, time to chase, then inbox items waiting for approval
  (oldest first, at most 50 read by one MGET of the pending ids). A card: `{key, kind: "todo" | "approval", id, title,
  line, actions}`; `actions` come from a fixed table per card kind and bucket, and only actions the viewer may take
  (`todo.close` for done/confirm/reject, `publish` for approve).
- Next skips a card for 3 hours: `sec:walk:{scope}` holds `{key: untilMs}` (one JSON value, TTL 1 day, stale entries
  dropped on write).
- Routes: `GET /api/secretary/walk` (member, `read`) → `{card, left}`; `POST /api/secretary/walk {action: "next", key}`
  (member, `todo.write`) → the next card. The card's other actions call the existing routes (`/api/secretary/{id}`,
  `/api/tasks/{id}`), so every gate stays where it is.
- The to-do page gets a "Walk me through" button that shows one card at a time with its buttons and a Next button.
- Chat and MCP tool `agenda_next {skip_id?}`: the next card as a tool line (and skips `skip_id` for 3 hours first).

## 5. Evening wrap

- Built in code in `src/lib/secretary-evening.ts` from stored facts only: items completed today (local day) with their
  result, approvals and rejections the owner decided today (from `decisions:{scope}`), items that fell overdue today,
  and the first three items the agenda would show at 09:00 tomorrow. No model, no motivational line.
- Silent when all four are empty. Sent once per scope per local day: marker `sec:wrap:{scope}:{day}` claimed with
  `setNx` (TTL 2 days).
- Delivered as one in-app notification (`kind: "todo"`), and one email when `RESEND_API_KEY` is set and the email
  preference is `all`.
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
  (i_owe, owedTo the agent, kind `follow_up`); to another agent → that agent owes it (they_owe, owedBy that agent, kind
  `waiting_on`). Title «توقّف عمل {agent}: {body}» / "{agent} is blocked: {body}" (cleaned, 200 characters; the Arabic
  reads the same whatever the grammatical gender of the agent's name). At most 20 blocked notes a day per account
  (`allow`).
- Before opening that item, the brand's open items are checked, under one lock per scope: an open item the same agent
  opened for the same party (source `agent`, `handoffFrom` = that agent, same direction and party) whose text says the
  same thing gets the new body as a note instead of a second item, and the tool answer says so. "The same thing" is
  `similarity` from `src/lib/similarity.ts` (word-bigram Dice) >= 0.6 between the stored body and the new one after
  normalising (controls removed, lower case, Arabic diacritics and tatweel removed, punctuation to spaces), or the
  two equal after normalising. The repo had no threshold for it elsewhere (`editPctOf` only measures edits), so 0.6 is
  new here.
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
