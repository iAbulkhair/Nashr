# Reem · ريم, the secretary: phase 1

Date: 2026-09-29. Status: built on `claude/secretary-reem`. Product name Thakeen (code name Nashr).

## What she is

The eighth agent, `reem`, role السكرتيرة / Secretary. She keeps the owner's own list: to-dos, follow-ups, what the owner owes others and what others owe the owner, with due dates in Riyadh time. She keeps the agenda, repeats every date back, and nudges. She owns no paid deliverable type and spends no credits.

Phase 1 adds no vendor, no environment variable, no WhatsApp or Telegram delivery and no time-based reminder job. Reminders reach the owner on the My to-dos page, in the 8 AM brief (and its email, per the owner's preference) and in one in-app follow-up per brand per Riyadh day.

## Data (Redis, per brand scope `sc(u)`)

| Key | Type | Holds |
|---|---|---|
| `sec:item:{scope}:{id}` | json | `SecItem` (`src/lib/secretary-agenda.ts`): id `s` + 16 hex, kind (task, follow_up, waiting_on, reminder), title ≤200, description ≤2000, result ≤1000 (required to complete), direction (i_owe, they_owe), owedBy / owedTo (`owner`, an agent id or a contact label ≤80), dueAt + allDay, snoozeUntil, priority 0-3, critical, links.taskId, source (owner, chat, mcp), notes ≤50 of ≤500 with a private flag, createdAt, updatedAt, completedAt, proposedDone, deletedAt, expiresAt, rev |
| `sec:open:{scope}` | sorted set | open ids by due time (undated last) |
| `sec:done:{scope}` | list | last 200 completed ids |
| `sec:deleted:{scope}` | sorted set | soft-deleted ids by expiry (restore view, purge) |
| `sec:all:{scope}` | set | every id not yet purged (account deletion) |
| `sec:audit:{scope}` | list | one line per change: at, actor, via, action, id, short diff; 500 kept |
| `sec:lock:{scope}:{id}` | lock | one writer per item, 10 s |

Status is derived, never stored. Writes to one item run under its lock and bump `rev`; a writer that sends an older `rev` gets 409. Reads are batched (one sorted-set read and one MGET).

## Agenda

Pure function over the items and the clock (`computeAgenda`). Buckets, in page order: overdue, today, needs your confirmation, next 7 days, waiting on others, later, no due date; snoozed items are counted and hidden until the snooze ends. Each entry carries the one who acts (the owner, an agent or a contact), the reason and the next step (do, chase, wait, confirm). Days are Riyadh calendar days (UTC+3, no daylight saving). The approvals inbox count is one line of the agenda, so Reem is the single queue.

## Rules in code

- Only the owner, in the app, completes (a written result is required), confirms or rejects a proposed "done", deletes (soft, 30 days) and restores. Chat and MCP create, update, snooze, note and propose.
- One automatic close: an item linked to an inbox task of the same brand closes with the result "linked item approved" when that task is approved. Never the model.
- Every key is built from the caller's scope; an id from a request is format-checked and must exist under that scope.
- Limits: 200 new items a day and 600 changes an hour per account, 600 reads an hour, 500 open items per brand.
- Text is cleaned (control and direction-override characters) and bounded; too long is refused, not cut. Text quoted from customers, suppliers or connectors is data.

## Surfaces

- API: `GET /api/secretary` (agenda, `?view=done|deleted`), `POST /api/secretary`, `PATCH /api/secretary/{id}` (update, complete, snooze, reschedule, confirm_done, reject_done, delete, restore, add_note).
- Chat tools (free, offered to every agent, Reem first): `agenda_get`, `todo_create` (answers with the stored date written for the owner: «الجمعة 2 أكتوبر 10:00 ص»), `todo_update`, `todo_propose_done`.
- MCP: the same four tools, free, in the bearer's active brand, source `mcp`.
- Page: `/{lang}/app/todo` (مهامي / My to-dos), server-rendered, linked in the sidebar under Approvals.
- Brief: counts of overdue, today, waiting and to-confirm, and the first three overdue or due-today titles. Follow-up: one `todo` notification per brand per Riyadh day when something is overdue.
- Daily cron: purge items deleted over 30 days ago (200 per brand per run) and close linked items whose task was approved; archived brands and suspended accounts get the purge only.

## Decisions the brief left open

- Two extra keys, `sec:deleted` and `sec:all`, so the restore view, the purge and account deletion never scan.
- A "later" bucket for items due after the next 7 days, and a `later` reason.
- `allDay`: a date without a time is due at 23:59 Riyadh time on that day and is shown without a time.
- Once someone else's item is overdue, the owner is the one to act ("chase"); before that it waits on them.
- Audit actors: `owner`, the chatting agent's id (Reem or another agent), `mcp`, `cron`, and `rule` for the automatic close.
- Ids start with `s` so the Redis client never reads one as a number.
- Snooze presets are computed on the server: 2 hours, tonight 20:00 (offered only while it is ahead), tomorrow 09:00.
- Phase 1 has no "reopen" of a completed item, no notes editor on the page (the API takes notes, private ones from the owner only; the page shows each row's last three notes), and no sidebar badge.

## Review fixes (2026-09-29)

- A link closes an item, so chat and MCP set one only at creation and only to a pending inbox item; `todo_update` never reads `task_id`, and only the owner, in the app, changes a link. The MCP route does not check arguments against the tool schema, so this is decided in code (`toolFields`, `mutateItem`, `createItem`).
- The daily purge also runs for archived brands and suspended accounts (`dailyRoster().idle`, `purgeIdle`), which otherwise get no scheduled work.
- A proposal ends a snooze and is classed before it, so the owner can always confirm it. A restore that reopens an item counts against the 500 open items.
- Every agent's uncached prompt block carries the current Riyadh date and time; `todo_create` says when a saved date has already passed.
- Honest copy: nothing fires at an item's due time in phase 1, so the chips and help say "Add:" / «سجّل عليّ» instead of "Remind me", the site says "In the morning brief and alerts", and Reem's prompt and playbook forbid promising a reminder at a set time.
- The page shows notes, words the owner's "Not yet" note in the page's language, reads «اقتراح إغلاق من» before the proposer, shows Undo as a toast, and counts in Arabic with the right noun form. The governance page offers a cap only to agents that own a paid type.

## Design references (ideas only, no code copied)

A computed "who owes what" agenda; a result required to close and a derived status; soft delete for 30 days with an audit line per change, and the agent never closing its own commitments; one note thread per item with private notes; the owner's edits recorded as corrections.

## Next (not in phase 1)

WhatsApp or Telegram reminders (Meta's policy on AI providers in WhatsApp must be checked first), a time-based reminder job, recurring items, reopening, and an overdue badge in the sidebar.
