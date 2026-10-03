# Reem phase 3 A2: recurring items and the 90-day purge of closed copies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An item can repeat. Closing one copy opens the next on its next scheduled date, once, with no pile-up. Closed copies of a series are deleted 90 days after they close, after a warning of at least 7 days, unless the customer keeps the series' history. The customer can download a series as CSV.

**Architecture:**
- The rule maths is split in two. Pure Gregorian candidates live in `secretary-agenda.ts` (client-safe, no new imports). The dispatcher `nextOccurrence` and the Hijri months live in `secretary-calendar.ts` (server only), because Hijri needs `seasons.ts`.
- `secretary.ts` owns the item lifecycle. Every close path (`complete`, `confirm_done`, the new `skip`, and `closeLinked`) ends in one private `spawnNext`, which claims the spawn with `setNx`, then writes the new copy and the closed copy in two rounds under the closed copy's lock.
- A new server module, `secretary-series.ts`, owns warn, purge, keep and the series rows. `secretaryDaily` imports it dynamically, as it already does for other steps (avoids the import cycle with `notifications.ts`).
- Reem and MCP set a repeat through `todo_create` and `todo_update`. A gate in `runSecretaryTool` refuses it for every other agent before anything is saved.

**Tech Stack:** Next.js 16 app router, TypeScript, Upstash Redis via `src/lib/db.ts` (in-memory store in tests), Vitest, ICU `Intl` (Umm al-Qura) in `src/lib/seasons.ts` only.

**Spec:** `docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md`, sections 4, 5, 6, 7, 8 (A2), 9 and 11. Read it before starting: this plan argues from it. Where this plan's rulings (R32-R54 below) differ from the spec, the plan wins and Task 10 amends the spec in the same PR.

**Branch:** A1 (PR #243) is merged (`ad6f1b6`). A2 branches from `main`: `claude/reem-phase3a2-recurring`. The PR opens as a draft and waits for the founder's explicit «ادمج».

**Line numbers** in this plan come from the context map made on the A1 head. Re-check each one with `grep` before editing; the merge may have moved them.

## Global Constraints

**Isolation, auth and store**
- Every key comes from `sc(u)` (routes), `sc(user)` (tools) or the bearer's scope. Never build a key from a scope, email, series id or item id taken from a request body. A series id from the URL is checked with `SERIES_ID` and then looked up under `sc(u)` only.
- Every route calls `currentUser()` first, then `forbid(u, action)`, then a rate limit from `allow()` in `src/lib/rate.ts`.
- No `await db.*` inside a loop. Use `Promise.all` or `pmap` from `src/lib/parallel.ts` (concurrency 8 for per-item locks).
- `Store.setNx` needs a TTL, so only the spawn claim uses it. The new copy is written with `get` then `set` under the closed copy's lock (R33).

**Calendar and dates**
- `Intl.DateTimeFormat` may be constructed only in `src/lib/dates.ts` and `src/lib/seasons.ts` (rule 37).
- `src/lib/secretary-agenda.ts` imports only `./dates`, `./agents` and `./zones` (`tests/client-bundle.test.ts:63-65`). No new import line.
- Dates in UI and tool text use Latin digits.

**Values copied from the spec**
- `interval` 1-99; `workday` always 1; `hyear` at most 10. `count` 1-999. `remindBefore` 0-10080 minutes.
- Spawn claim TTL: 172800 s (2 days).
- Purge: 90 days; warn 7 days before; `zrangeByScore` limit 200 per run; keep limit 500 series.
- Warn notification names at most 5 series, then "and {k} more".
- CSV: up to 5000 rows then a "truncated" row; MGET chunks of 500. Series view: 200 rows.

**Product rules**
- No credits, no model call. No invented numbers, results promises or customers in copy.
- Do not put the numbers forbidden by `tests/pricing-copy.test.ts:299-313` (for example 250) in `app-i18n`, help, changelog or skill copy.
- The model is never the only approval: ending a series, skipping and deleting stay owner-only in code, not only in the prompt. Other agents cannot set a repeat (code gate). Reem and MCP can, as the spec accepts; text Reem reads is untrusted input, and the spec's limit is that a repeat never ends or deletes anything on its own.

**Rules and tests**
- Rule numbers 490-509 belong to this PR. Rules 201, 306, 487 and 489 are extended, not renumbered.
- Test files: `tests/secretary-repeat.test.ts` (rules 490-501) and `tests/secretary-series.test.ts` (rules 502-509). Each `describe` names its rule number. Update `docs/system/tests.md` in the same commit as each rule, and run the duplicate-number check after merges. Row 457 of `tests.md` ("490-509 Reserved for Reem phase 3 A2 … not written yet") is replaced by individual rows as each rule lands; Task 10 removes whatever is left of it.

**Commands**
- Before each commit: `npm run check`.
- Once for a fresh worktree: `npm ci --cache "$TMPDIR/npm-cache"` and `npx next typegen`.
- `npx next build` runs in CI. The local sandbox blocks it (fonts and port binding).

## Rulings (amend the spec; added to the PR description as R32-R54)

R32-R54 come from comparing the spec with the code at `ad6f1b6`. R48-R54 come from the adversarial review of this plan (2026-10-03) and the founder's answers to it. Visible to the customer: R34, R36, R37, R40, R44, R49, R50, R53. The rest are internal.

- **R32 Reopen deletes the next copy without `changeItem`.** `changeItem` refuses `delete` to anyone but the web owner and always audits the action name. A private `deleteNextCopy` takes the next copy's lock and deletes it with audit `series_reopen`, actor `rule`. `OWNER_ONLY` and `isOwner` are not widened.
- **R33 One writer per spawn.** The new copy is written with `get`, then `set` only if absent, under the closed copy's lock. Only a spawn of the same closed id knows the claimed id, and it holds that lock. The claim itself is `setNx` with the 2-day TTL.
- **R34 Reopen clears `nextId` and the claim only when the next copy was really deleted, or is missing or soft-deleted.** If the next copy is kept (edited and open, or already done), `nextId` and the claim stay, so closing the reopened copy again opens nothing. The note «النسخة التالية مفتوحة ومعدّلة…» is written whenever any open copy of the series exists after the reopen (R49). The spec said to clear them always; that would spawn a third copy.
- **R35 "Untouched" means** open and `rev === 1 + (number of reminded notes)`, with no other notes. A reminder that already fired does not make the copy "edited".
- **R36 The rule carries the time.** `SecRepeat.time?: "HH:mm"` (absent = all-day) is set when the rule is set or changed, from the item's `dueAt`. A copy is built from the rule's time. A reschedule changes one copy's date and time and never the cadence or the time. (The page's reschedule form turns an all-day item into a timed 23:59 one; without this the next copy would inherit that.)
- **R37 `remindBefore` is stored only when 0 ≤ minutes ≤ 10080.** Otherwise the reminder applies to this copy only and `remindBefore` is deleted. Clearing the reminder on purpose deletes it. `fireReminder` never touches the rule.
- **R38 One `repeat_needs_due` check** in `mutateItem`, after the update and reschedule branches build `next`: `next.repeat && !next.dueAt`. Update, reschedule to null and `clear_due` all pass through it.
- **R39 `closeLinked(scope, id, who, at: { zone, cal })`.** `changeItem` reads the calendar for every close action. A copy spawned while an agenda is being read shows on the next read; the claim and the open-state check make repeated reads idempotent. Copies carry no links, so only a series' first copy can auto-close.
- **R40 Spawned copies skip the date range check; the page's reschedule keeps it.** A copy of a yearly series with an interval above 5 can be further than `WHEN_RANGE` (now + 5 years); rescheduling such a copy must stay inside the range. `parseRepeat` keeps the spec's bounds.
- **R41 Spawned copy fields not in the spec table:** `expectBy: null`, `createdAt` and `updatedAt` = now, `completedAt`, `deletedAt`, `expiresAt` = null, no `nextId`, `source` = the closed copy's. Without `remindBefore`, `remindAt` is null.
- **R42 Series minted when a repeat is first set** on an item with no `series`: `{ id: newSeriesId(), n: 1 }`. It is kept after `stop_repeat`, so the history stays exportable.
- **R43 Kept series stay out of `sec:sdone` through a flag.** `indexWrites(scope, prev, next, opts?: { kept?: boolean })`; the caller reads `SISMEMBER sec:serieskeep` under the lock, in parallel with its other reads. The warn step also reads `SMEMBERS sec:serieskeep` once and skips kept ids, which guards a keep that raced a close.
- **R44 Warn moves ids only after a push that returned a notification, and warns once per series (founder, 2026-10-03).** A same-day rerun (the fingerprint was claimed) moves nothing; a throw moves nothing. Only the ids of the (at most 5) series the text names move; the rest wait for the next day. A series is named once, then a marker `sec:swarn:{scope}:{seriesId}` (`setNx`, 30 days) silences it, so a daily series does not produce a bell entry and an email every day. The invariant is per series: a copy is deleted at least 7 days after a warning that named its series. Copies of a warned series that reach the window later move to `sec:spurge` with score `max(completedAt + 90 d, warnedAt + 7 d)` and no new notification; they are always later than the copy that was named, so the 7 days hold. When the marker lapses the series is named again (about monthly for a daily series).
- **R45 Chat tool schemas stay strict-safe.** `repeat` is a nested object with `additionalProperties: false`, `required: ["every"]`, `every` an enum, plain integers and strings, no `minimum`, `maximum` or `minLength`. Every range check is in `parseRepeat`.
- **R46 Gate before spending.** `runSecretaryTool`'s ctx gains `agent?: AgentId`; `runTool` passes `agent: ctx.agent` and keeps its `?? "reem"` actor default only for the actor. The gate runs before `allow()`, so a refused call spends no `sec:write`.
- **R47 `withLock` is unchanged** (TTL 10 s covers two rounds and one nested delete). The optional `lockOwned` path in spec §4.3 is not taken.
- **R48 Reopen fails closed.** `deleteNextCopy` returns `"deleted" | "kept" | "gone" | "failed"`. A lock timeout (`lock_timeout`, 503) or a failed read is `"failed"`: the reopen answers 503 before anything is written, so `nextId` and the claim are never cleared on a guess.
- **R49 The `two_open` note follows the series, not only `nextId`.** After a reopen, if any copy of the series is open (follow the `nextId` chain, or read the series set), the reopened copy gets the note. Example: A → B (done) → C (open); reopening A leaves A and C open and says so.
- **R50 Warn cleans what it skips.** The warn step ZREMs kept ids and ghost ids (missing record, or not done) from `sec:sdone` as it skips them, so they never fill the 200-row window. Every `indexWrites` caller passes `kept` (`spawnNext`, the plain close path for the last copy of an ended or stopped series, `restore`, `reopen`). The daily step also re-adds, for unkept series, closed copies missing from both `sdone` and `spurge` (this makes un-keep resumable if it died half-way).
- **R51 Round order.** `spawnNext` writes the closed copy first (`nextId` = the claimed id), then the new copy. A `nextId` that names a missing record already means "spawn again", so a crash between the rounds leaves nothing visible. This replaces spec §4.3 "Round 1 / Round 2".
- **R52 The open-cap check is skipped on a reopen** when `deleteNextCopy` will delete an open next copy: the net change is zero.
- **R53 An edit of the time of day on a recurring copy changes the rule (founder, 2026-10-03).** The `update` path (not `reschedule`) that changes `dueAt`'s time of day also sets `rule.time`, so the next copy keeps the new time. `reschedule` stays a one-off.
- **R54 Rate keys are per email and the limit comes first.** Both routes use `sec:write:{email}` / `sec:read:{email}` as the other secretary routes do, before the `ZCARD`. The series view and the CSV read the whole series set on each request; this is accepted for A2.

## Review Focus

Inputs the spec implies but no other task pins. Each line names the task that adds its test.

1. **Reopen, edit the next copy, close the reopened copy again.** Opens nothing; two open copies stay two. → Task 5.
2. **A reminder fires on the next copy, then the first copy is reopened.** The next copy is still "untouched" and is deleted. → Task 5.
3. **An all-day item rescheduled from the page (becomes timed 23:59), then closed.** The next copy is all-day again, on the grid. → Task 1.
4. **A claim already seeded with an orphan record, and a second spawn of the same closed copy.** The same id is reused; nothing is overwritten. → Task 5.
5. **Kept ids and ghost ids in `sec:sdone` with the real candidate behind 200 of them.** The warn step removes them and still warns the candidate; the test seeds `sdone` directly, so deleting the skip guard fails it. → Task 7.
6. **A daily series for four months.** One warning per series, not one per day; every copy is deleted at least 7 days after the warning that named its series. → Task 7.
7. **A series id of another brand, with the right shape.** 404, nothing written, nothing read from that brand. → Task 8.
8. **Account deletion with a recurring item whose copy was spawned.** Every new key is gone, including `sec:spawn:*`. → Task 4.

---

### Task 1: Types and the Gregorian rule maths (browser-safe)

**Files:**
- Modify: `src/lib/secretary-agenda.ts`
- Test: `tests/secretary-repeat.test.ts` (new)

**Interfaces:**
- Produces, in `secretary-agenda.ts` (pure, imports unchanged):
  - `SecRepeat = { every: "day"|"workday"|"week"|"month"|"year"|"hmonth"|"hyear"; interval: number; anchor: string; weekStart: number; time?: string; weekdays?: number[]; monthDay?: number; remindBefore?: number; until?: string; count?: number }`.
  - Optional `SecItem` fields: `repeat?: SecRepeat | null`, `series?: { id: string; n: number }`, `nextId?: string`, `closedBy?: { actor: SecActor; login?: string }`.
  - `SecNote` kind `"two_open"`, worded in both languages by `noteText`. `SKIP_RESULT` constant.
  - `CalData.hijriFix?: Record<string, { shawwal1?: string; dhulhijja1?: string }>` (optional, so `defaultCal` and the existing `toEqual` test stay unchanged).
  - `weekdayOf(day)`, `weekStartOf(day, weekStart) = addDays(day, -((weekdayOf(day) - weekStart + 7) % 7))`, `addMonthsClamped(day, months, monthDay?)` (`monthDay -1` = last day, built on `Date.UTC(y, m + n + 1, 0)`).
  - `gregorianNext(rule, prevDueMs, now, z, cal): { dueAt: string; allDay: boolean } | null` for `day`, `workday` (via `isQuietDay`), `week`, `month`, `year`. Candidate k = anchor + k·interval units, always from the anchor, clamped per candidate and never fed back. Result: the first candidate O with O > prevDue, and for timed items O > now, for all-day items O ≥ start of today. `until` ends it.
  - `repeatText(rule, lang)`: inline Arabic and English tables for weekdays and Hijri months, with dual forms («كل أسبوعين»), Latin digits.

- [ ] **Step 1: Write the failing tests (rules 490, 491, 501)**

```ts
describe("rule 490: month and year candidates clamp per candidate from the anchor", () => {
  const z = "Asia/Riyadh"; const cal = defaultCal(z);
  const rule = (o: Partial<SecRepeat>): SecRepeat => ({ every: "month", interval: 1, anchor: "2026-01-31", weekStart: 0, ...o });
  it("31 Jan → 28 Feb → 31 Mar", () => {
    const a = gregorianNext(rule({}), Date.parse("2026-01-31T23:59:00+03:00"), Date.parse("2026-01-31T12:00:00+03:00"), z, cal)!;
    expect(a.dueAt.slice(0, 10)).toBe("2026-02-28");
    const b = gregorianNext(rule({}), Date.parse(a.dueAt), Date.parse("2026-02-28T12:00:00+03:00"), z, cal)!;
    expect(b.dueAt.slice(0, 10)).toBe("2026-03-31");
  });
  it("29 Feb 2028 → 28 Feb 2029 → … → 29 Feb 2032", () => { /* every:"year", anchor 2028-02-29 */ });
  it("monthDay -1 is the last day of every month", () => { /* 2026-02-28, 2026-03-31, 2026-04-30 */ });
});

describe("rule 491: week grid, workdays, no pile-up, reschedule, timed vs all-day", () => {
  it("every 2 weeks on Sun+Tue keeps its grid after a close 3 weeks late and opens ONE copy", () => {});
  it("workday skips the weekend and a quiet Eid day from CalData", () => {});
  it("a timed copy whose time passed today opens on the next date; an all-day copy opens today", () => {});
  it("a reschedule moves one copy; the next copy is built from the anchor grid and the rule's time (R36)", () => {});
  it("until ends the series (null)", () => {});
});

describe("rule 501: repeatText and itemLine", () => {
  it("«يتكرر كل يوم أحد» / 'Repeats every Sunday', Hijri monthly, dual forms, Latin digits", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.** `npx vitest run tests/secretary-repeat.test.ts`. Expected: FAIL, `gregorianNext` is not exported.
- [ ] **Step 3: Implement it.** Search is bounded at 366 × interval days. `week`: 7-day blocks counted from `weekStartOf(anchor, rule.weekStart)`; block k·interval carries the chosen weekdays (default the anchor's weekday). `time` absent means all-day (`endOfZoneDay`); present means `zoneTime(day, hh, mm, z)`.
- [ ] **Step 4: Run it and `tests/client-bundle.test.ts`.** Expected: PASS, with the import pin unchanged.
- [ ] **Step 5: Add rows 490, 491, 501 to `docs/system/tests.md` and commit.** `git commit -m "feat(reem): repeat rule types and Gregorian next date (rules 490, 491, 501)"`.

---

### Task 2: Hijri occurrences and the dispatcher (server only)

**Files:**
- Modify: `src/lib/secretary-calendar.ts`
- Test: `tests/secretary-repeat.test.ts`

**Interfaces:**
- `build()` fills `data.hijriFix` with the valid fixes for Hijri years ≥ the current one (conditional spread).
- Produces `hijriMonthStart(y, m, zone, fix?)`, memoised, applying the fix to months 10 and 12 and the spec's R26 rule to month 9. Exported (today's `uqMonthStart` is private).
- Produces `nextOccurrence(rule: SecRepeat, prevDue: string, now: number, z: Zone, cal: CalData, n: number): { dueAt: string; allDay: boolean } | null`:
  - Gregorian rules go to `gregorianNext`.
  - `hmonth` and `hyear` use `hijriMonthStart` and clamp 30 → 29 per candidate.
  - Returns `null` when `n >= rule.count`, or the next date is after `until`, or the bounded search finds nothing.

- [ ] **Step 1: Write the failing tests (rules 492, 493)**

```ts
describe("rule 492: Hijri monthly and yearly occurrences", () => {
  it("Hijri 30 → 29 → 30 (dates rechecked against ICU in the test)", () => {});
  it("a hijriFix shifts the hmonth copy that falls on 1 Shawwal or 1 Dhu al-Hijjah", () => {});
  it("hyear keeps the anchor's Hijri month and day", () => {});
});
describe("rule 493: the series ends on count or until, and the search is bounded", () => {
  it("n >= count gives null; a date after until gives null", () => {});
  it("an impossible rule returns null within 366 × interval days instead of looping", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.** Do not add an import to `secretary-agenda.ts`.
- [ ] **Step 4: Run it and `tests/secretary-calendar.test.ts`.** Expected: PASS, with `tests/secretary-calendar.test.ts:119` unchanged.
- [ ] **Step 5: Add rows 492, 493 and commit.** `git commit -m "feat(reem): Hijri repeat dates and nextOccurrence (rules 492, 493)"`.

---

### Task 3: Rule validation and per-item behaviour

**Files:**
- Modify: `src/lib/secretary.ts`, `src/lib/app-i18n.ts`
- Test: `tests/secretary-repeat.test.ts`

**Interfaces:**
- `SecError` gains `repeat_invalid`, `repeat_needs_due`, `keep_limit`. `TOOL_ERRORS` (a `Record<SecError, string>`) and both `app-i18n` error maps get entries, plus page text for `owner_only` (extend the tool sentence to "stop or end a repeat").
- `SERIES_ID = /^r[a-f0-9]{16}$/`, `newSeriesId()`.
- `parseRepeat(v, now, z)`: every range check lives here (`repeat_invalid`); `until` is a real day (`isLocalDay`), not before today; `count` 1-999. `SecFields.repeat`.
- `applyFields` and `mutateItem`: setting a rule fixes `anchor`, `weekStart` and `time` from the calendar and the item (R36), mints `series` (R42), and gives an undated item its first `dueAt`. The one `repeat_needs_due` check (R38). `remindBefore` set and cleared from the reminder (R37). A non-owner gets `owner_only` (field `repeat`) when the new repeat is null, when `count <= series.n`, or when `until` is before the local day of `nextOccurrence(newRule, dueAt, …)`.
- New `Change` actions `skip` (in `OWNER_ONLY`, stores `SKIP_RESULT`, `bad_action` on an item with no repeat) and `stop_repeat` (`todo.write`, sets `repeat = null`). `parseOwnerChange` accepts both. `closedBy` is set in `complete`, `confirm_done`, `skip` and `closeLinked`, cleared in `reopen`. `diffOf` gains `repeat`, `series`, `nextId`, `closedBy`.
- `createItem` accepts `repeat` but refuses it from source `"agent"`.
- `changeItem` calls `calFor` for every close action (R39).
- The `update` path that changes the time of day of a recurring item's `dueAt` also sets `rule.time` (R53).

- [ ] **Step 1: Write the failing tests (rules 494, 495)**

```ts
describe("rule 494: a repeat needs a due date, from every caller", () => {
  it("update with dueAt null, reschedule to null and todo_update clear_due all answer repeat_needs_due (400, field dueAt)", () => {});
  it("setting repeat on an undated item gives it the first occurrence, all-day", () => {});
  it("a reminder on a recurring open item sets remindBefore; clear_remind deletes it; a reminder later than the due date applies to this copy only (R37)", () => {});
  it("parseRepeat refuses interval 0 or 100, hyear above 10, a past until, count 0 or 1000, weekdays of 8 (repeat_invalid)", () => {});
  it("editing a daily 09:00 item to 14:00 through update makes the next copy 14:00; a reschedule of one copy does not (R53)", () => {});
});
describe("rule 495: skip, stop and ending a series are owner-only", () => {
  it("skip needs todo.close through the PATCH route; a member gets 403", () => {});
  it("skip closes with SKIP_RESULT and sets closedBy; delete ends the series and opens nothing", () => {});
  it("stop_repeat on the page needs todo.write and keeps series for the CSV", () => {});
  it("from chat or MCP, stop_repeat, an early until and count <= n answer owner_only", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it, then `npx vitest run tests/secretary.test.ts tests/secretary-page.test.ts`.** Expected: PASS.
- [ ] **Step 5: Add rows 494, 495 and commit.** `git commit -m "feat(reem): repeat validation, skip, stop and closedBy (rules 494, 495)"`.

---

### Task 4: Keys and indexes

**Files:**
- Modify: `src/lib/secretary.ts` (`SEC_KEYS`, `indexWrites`, `purgeExpired`, `secretaryKeys`), `docs/system/architecture.md` §3
- Test: `tests/secretary-series.test.ts` (new); extend rules 201, 306 and 489

**Interfaces:**
- `SEC_KEYS` gains `series(scope, id)`, `seriesList(scope)`, `sdone(scope)`, `spurge(scope)`, `seriesKeep(scope)`, `spawn(scope, id)`, `swarn(scope, id)` (the R44 marker). No default parameters (rule 489 fills each family by `Function.length`).
- `indexWrites(scope, prev, next, opts?: { kept?: boolean })` (R43):
  - `to === "done" && from !== "done" && next.series`: ZADD `sec:series:…` (score `Date.parse(completedAt)`), SADD `serieslist`, and ZADD `sdone` unless kept. This covers a restored deleted closed copy (today `indexWrites` re-indexes `sec:done` only when `!prev?.completedAt`).
  - `from === "done" && to !== "done" && prev.series`: ZREM from `series`, `sdone`, `spurge`.
- Every `indexWrites` caller passes `kept` (R50): `spawnNext`, the plain close path, `restore`, `reopen`.
- `purgeExpired` also ZREMs the series indexes from `row.series.id`, and SREMs the series from `serieslist` when its last copy is gone.
- `secretaryKeys` reads `serieslist` in the same `Promise.all` and lists the series keys, the `sec:swarn:*` key for every listed series, and the `sec:spawn:*` key for every id in `sec:all`. A claim of an already purged copy lapses by its 2-day TTL; the test states this exception.
- Architecture §3 rows are written in this task, after the `secawayprops` row.

- [ ] **Step 1: Write the failing tests (rules 496, 508)**

```ts
describe("rule 496: series indexes follow every transition", () => {
  it("done → open, done → deleted and purge remove the id from series, sdone and spurge", () => {});
  it("deleted → done (restore) indexes the copy again", () => {});
  it("a kept series is not added to sdone", () => {});
});
describe("rule 508: account deletion removes every new key", () => {
  it("a closed recurring copy, its series set, serieslist, sdone, spurge, serieskeep, its swarn marker and the spawn claim of every copy still in sec:all are gone", () => {});
  it("purging the last copy of a series removes it from serieslist", () => {});
});
```

Extend rules 201, 306 and 489 to seed a closed recurring copy and a series, and keep rule 489's check that each `SEC_KEYS` family has a matching architecture row.

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it, including the architecture rows.**
- [ ] **Step 4: Run it and `tests/secretary.test.ts tests/secretary-calendar.test.ts`.** Expected: PASS.
- [ ] **Step 5: Add rows 496, 508, mark 201, 306, 489 as extended, and commit.** `git commit -m "feat(reem): series keys and indexes (rules 496, 508)"`.

---

### Task 5: Spawn the next copy on every close path

**Files:**
- Modify: `src/lib/secretary.ts`
- Test: `tests/secretary-repeat.test.ts`

**Interfaces:**
- Private `spawnNext(scope, cur, closed, who, at: { zone; cal }, kept)` per spec §4.3 with R33, R39 and R41:
  1. Skip when no repeat, the series ended, or `nextId` names a live record. If `nextId` names a missing record, spawn again.
  2. Claim `sec:spawn:{scope}:{closedId}` with `setNx` (2 days, value `newSecId()`). A claim naming a live record keeps it unchanged; one naming a soft-deleted record is stale, so mint a new id and overwrite the claim. A live record is never overwritten.
  3. Build the copy from the spec table plus R41. `links`, `notes`, `result`, `proposedDone`, `snoozeUntil`, `lastChasedAt`, `handoffFrom` and `closedBy` are not copied.
  4. Round order (R51): round 1 writes the closed copy with `nextId` = the claimed id and `closedBy`, `indexWrites(scope, prev, closed, { kept })`, and the close audit line. Round 2 writes the new copy if absent, `indexWrites(scope, null, next)`, and the `spawn` audit line (actor `rule`). A failure after round 1 leaves `nextId` naming a missing record, which means "spawn again", so the retry reuses the claim and nothing is visible twice.
- `closeLinked(scope, id, who, at: { zone: Zone; cal: CalData })`, fed from `agendaWith` with `calOf`'s result.
- Private `deleteNextCopy(scope, nextId, now): Promise<"deleted" | "kept" | "gone" | "failed">` (R32, R35, R48): takes the next copy's lock, re-reads it, deletes only an untouched open copy, writes audit `series_reopen` with actor `rule`. A lock timeout or a failed read is `"failed"`.
- `reopen`: when the closed copy has `nextId`, call `deleteNextCopy` inside the reopen's own lock. `"failed"` answers 503 before anything is written (R48). On `"deleted"` or `"gone"`, clear `nextId` and DEL the claim. On `"kept"`, keep both (R34). The `two_open` note is written whenever any open copy of the series exists after the reopen (R49).
- `reopen` and `restore` still check `SEC_OPEN_MAX`, except that a reopen whose `deleteNextCopy` deletes an open next copy skips the check (R52). A close plus a spawn leaves the open count unchanged and checks neither the cap nor the per-email create allowance.

- [ ] **Step 1: Write the failing tests (rules 497, 498, 499)**

```ts
describe("rule 497: exactly one next copy", () => {
  // Two concurrent complete calls die at the `completed` 409 guard before any spawn code, so they pin nothing about the claim.
  // These tests exercise the claim and the nextId guard directly.
  it("a pre-seeded claim plus an orphan record: the spawn reuses that exact id and overwrites nothing", () => {});
  it("a pre-seeded claim naming a soft-deleted record is stale: a new id is minted and the claim overwritten", () => {});
  it("a failure after round 1 (nextId set, no new copy) and a retry give one copy at the claimed id", () => {});
  it("reopen then re-close within 2 days opens a new id, and sec:deleted holds no open item", () => {});
  it("a re-close while the next copy is alive opens nothing", () => {});
  it("nextId naming a missing record spawns again", () => {});
  it("two concurrent complete calls: one wins, the other answers completed 409, and there is one next copy", () => {});
});
describe("rule 498: what the next copy carries", () => {
  it("links, notes, result, proposedDone and closedBy are not copied; expectBy is null; the date and time come from the rule", () => {});
  it("a reminder fires, then complete: the next copy has a reminder at remindBefore", () => {});
  it("clear_remind, then complete: the next copy has none", () => {});
  it("closing a weekly copy 3 weeks late opens one copy at the next date", () => {});
});
describe("rule 499: reopen and the next copy", () => {
  it("an untouched next copy is deleted, audit series_reopen by rule", () => {});
  it("a next copy whose reminder already fired is still untouched (R35)", () => {});
  it("an edited next copy stays: two open copies, the two_open note, nextId and the claim kept (R34)", () => {});
  it("closing the reopened copy again then opens nothing", () => {});
  it("A → B (done) → C (open): reopening A leaves A and C open and writes the two_open note (R49)", () => {});
  it("a lock timeout on the next copy answers 503, writes nothing, and keeps nextId and the claim (R48)", () => {});
  it("at the open-items cap, reopening A with an untouched open B succeeds (R52)", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it, then `npx vitest run tests/secretary.test.ts tests/secretary-away.test.ts`.** Expected: PASS, including the rule 198 `db.lock` spy lists.
- [ ] **Step 5: Add rows 497, 498, 499 and commit.** `git commit -m "feat(reem): open the next copy once on every close path (rules 497-499)"`.

---

### Task 6: Chat and MCP tools

**Files:**
- Modify: `src/lib/secretary.ts` (`SEC_TOOL_DEFS`, `toolFields`, `runSecretaryTool`, `itemLine`), `src/lib/chat.ts` (`runTool`, the shared and Reem prompt lines)
- Test: `tests/secretary-repeat.test.ts`

**Interfaces:**
- `todo_create` and `todo_update` gain `repeat` and `stop_repeat`, strict-safe (R45). `toolFields` maps `repeat` into `SecFields.repeat`.
- `runSecretaryTool(user, name, input, ctx: { who; lang; agent?: AgentId })` (R46). The gate `(input.repeat !== undefined || input.stop_repeat !== undefined) && who.via !== "mcp" && ctx.agent !== "reem"` runs before `allow()`. For a refused call the answer is «لم يتم: التكرار يضبطه المالك أو ريم» / "Not done: only the owner or Reem sets a repeat", and nothing in that call is saved. `stop_repeat` over chat or MCP answers `owner_only`.
- `runTool` passes `agent: ctx.agent`. `itemLine` appends `repeats: ${repeatText(rule, "en")}`.
- `secretary-handoff.ts` never carries `repeat` (assert it; change it only if the assertion fails).

- [ ] **Step 1: Write the failing tests (rule 500)**

```ts
describe("rule 500: who may set a repeat", () => {
  it("Noor's todo_create with repeat is refused, saves nothing and leaves rate:sec:write null", () => {});
  it("ask_noor (via MCP, actor noor, chat) is refused the same way", () => {});
  it("Reem in chat and the owner's MCP assistant can set repeat", () => {});
  it("stop_repeat over MCP and over chat is owner_only", () => {});
  it("a handoff note never carries repeat", () => {});
  it("the tool schema has no minimum, maximum, minLength or maxLength and every object has additionalProperties:false", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it, then `npx vitest run tests/secretary.test.ts tests/mcp.test.ts`.** Expected: PASS.
- [ ] **Step 5: Add row 500 and commit.** `git commit -m "feat(reem): repeat through Reem's chat and MCP, owner-only to end (rule 500)"`.

---

### Task 7: Warn and purge in the daily job

**Files:**
- Create: `src/lib/secretary-series.ts`
- Modify: `src/lib/secretary.ts` (`secretaryDaily`), `src/app/api/cron/daily/route.ts`
- Test: `tests/secretary-series.test.ts`

**Interfaces:**
- `warnSeries(scope, now): Promise<number>` (R43, R44, R50). Reads `zrangeByScore(sec:sdone, now − 83 d, 200)`.
  - It ZREMs kept ids and ghost ids (missing record, or not done) as it skips them.
  - Series with a live `sec:swarn` marker are not named again; their due copies move to `spurge` with score `max(completedAt + 90 d, warnedAt + 7 d)` without a notification.
  - For the other series it builds one notification per brand (kind `todo`, href `/{lang}/app/todo?series={id}` of the first named series, fingerprint `brandFingerprint(scope, "todo-purge:{localDay}")`, 7-day TTL), then, only after a push that returned a notification, sets `sec:swarn` (`setNx`, 30 days) for the named series and moves their ids from `sdone` to `spurge` with score `max(completedAt + 90 d, now + 7 d)`.
  - Email follows the scope's email preference and is sent only for a new push. Text and `arCount` per spec §5.2.
  - The daily step also re-adds to `sdone`, for unkept series, closed copies missing from both `sdone` and `spurge`.
- `purgeSeries(scope, now): Promise<number>`: `zrangeByScore(sec:spurge, now, 200)`, `pmap` (concurrency 8), each under its own item lock, re-read, `SISMEMBER serieskeep`, delete only when still done and not kept, remove the id from every index, one audit line with the count.
- `setSeriesKeep(scope, id, keep, who)` and `seriesRows(scope, id, limit)` live here too (Task 8 uses them). `setSeriesKeep` runs under `withLock(scope, "serieskeep")`, answers `keep_limit` 409 at 500 when the id is not already kept, writes `serieskeep` first, then moves the ids with `pmap`. Un-keep ZADDs the closed copies back into `sdone` only.
- `secretaryDaily` imports the module dynamically and wraps each step in `.catch`, as `cleanAway` is wrapped. The account is `scope.split("#")[0]`, the language from `getUser`, the zone from `zoneFor`. The outcome string gains `{p}p{c}c{a}a{w}w{d}d` (purged, closed, away, warned, deleted). Idle brands (archived or suspended) run neither step.

- [ ] **Step 1: Write the failing tests (rules 502-505)**

```ts
describe("rule 502: the unkept copy is warned and then deleted", () => {
  it("250 kept copies older than 90 days plus 1 unkept: the unkept one is warned, then deleted 7 or more days later", () => {});
  it("sdone seeded DIRECTLY with 250 kept and ghost ids ahead of one real candidate: the candidate is still warned, and the skipped ids are removed (fails if the skip guard is deleted)", () => {});
  it("the last copy of an ended series and a restored copy of a kept series do not enter sdone", () => {});
});
describe("rule 503: no copy is deleted without a warning at least 7 days earlier", () => {
  it("after un-keep, after a missed run, and when the warning push threw", () => {});
});
describe("rule 504: the purge is safe", () => {
  it("a reopen between the purge's read and its delete survives", () => {});
  it("normal items are never purged", () => {});
  it("idle brands are not warned or purged (through the cron route)", () => {});
});
describe("rule 505: the warning", () => {
  it("names at most 5 series then 'and k more', and moves only the named ids", () => {});
  it("a same-day rerun moves nothing; the fingerprint is the per-brand one", () => {});
  it("a daily series run for 120 simulated days produces one warning notification, not one per day, and every copy is deleted at least 7 days after the warning that named its series (R44)", () => {});
  it("when the 30-day marker lapses the series is named again", () => {});
  it("text uses arCount and Latin digits", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it, then `npx vitest run tests/cron.test.ts tests/secretary.test.ts`.** Expected: PASS.
- [ ] **Step 5: Add rows 502-505 and commit.** `git commit -m "feat(reem): warn then delete closed copies after 90 days (rules 502-505)"`.

---

### Task 8: The keep and export routes

**Files:**
- Create: `src/app/api/secretary/series/[seriesId]/keep/route.ts` (PUT), `src/app/api/secretary/series/[seriesId]/export/route.ts` (GET)
- Modify: `tests/role-gates.test.ts` (entries only)
- Test: `tests/secretary-series.test.ts`

**Interfaces:**
- Role gates: `ROUTE_ROLES["PUT /api/secretary/series/[seriesId]/keep"] = g("admin", "todo.write", "todo.close")`; `READS["GET /api/secretary/series/[seriesId]/export"] = g("member", "read")`.
- **Keep:** `currentUser` → `forbid(u, "todo.write")` → `allow("sec:write:{email}")` (R54, before the `ZCARD`) → `SERIES_ID` check and one `ZCARD` under `sc(u)` (404 otherwise, nothing written) → `typeof b.keep === "boolean"` (400) → `keep === false && !can(u, "todo.close")` gives 403 → `setSeriesKeep` → audit `series_keep` / `series_unkeep` with the login.
- **Export:** `currentUser` → `forbid(u, "read")` → `allow("sec:read:{email}")` (R54) → same id checks (404) → `seriesRows` newest first, `pmap` MGET in chunks of 500, up to 5000 rows then a "truncated" row. Columns: title, due, closed at, result, closed by. UTF-8 with BOM; each cell `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"` with `csvSafe` from `@/lib/admin-stats`; `Content-Disposition: series-{seriesId}.csv`, never the title. Copies closed before A2 export an empty "closed by". `SKIP_RESULT` is translated to text.

- [ ] **Step 1: Write the failing tests (rules 506, 507)**

```ts
describe("rule 506: the keep route", () => {
  it("a member's keep:false gets 403 and writes nothing", () => {});
  it("a malformed or unknown id gets 404 and writes nothing; another brand's well-formed id gets 404", () => {});
  it("a 501st kept series answers keep_limit 409", () => {});
});
describe("rule 507: the CSV export", () => {
  it("a result with a comma, a quote, a new line and a leading = is exported safely, with a BOM", () => {});
  it("only that series' set is read, and another brand's id gives 404", () => {});
  it("the file name is series-{seriesId}.csv and never the title", () => {});
});
```

- [ ] **Step 2: Run it and see it fail.** Expected: FAIL; `tests/role-gates.test.ts` also fails until the entries exist.
- [ ] **Step 3: Implement the routes.**
- [ ] **Step 4: Run it and `npx vitest run tests/role-gates.test.ts`.** Expected: PASS.
- [ ] **Step 5: Add rows 506, 507 and commit.** `git commit -m "feat(reem): keep a series' history and download it as CSV (rules 506, 507)"`.

---

### Task 9: The to-do page

**Files:**
- Modify: `src/app/[lang]/app/todo/page.tsx`, `src/components/app/TodoPanel.tsx`, `src/lib/app-i18n.ts`, `todoPage(scope, opts?)` in `src/lib/secretary.ts`
- Test: `tests/secretary-series.test.ts`; rule 487 stays green

**Interfaces:**
- `Page` takes an optional `searchParams?: Promise<{ series?: string | string[] }>`; a non-string or non-`SERIES_ID` value counts as absent. Four existing tests call `Page({ params: … })` and must not change.
- `todoPage(scope, opts?: { series?: string })` calls `seriesRows(scope, id, 200)` for the series view.
- `TodoRow` gains `repeat` (badge text from `repeatText`, computed on the server in `row()`, and form defaults), `seriesId`, and the "closed by" text.
- New panel kind `"repeat"` with a rule form; a **Skip** button (`canClose`); a **Stop repeat** button (`todo.write`). The add form's repeat control uses selects, checkboxes and number inputs: no `type="time"` and no `role="switch"` (the due time stays in the existing datetime-local; rule 487 counts exactly two time inputs and disables every one). The reschedule form's range note mentions R40.
- The `?series=` view shows the rows, a **Keep history** switch (`useOneWrite` PUT; rendered only here, disabled for turning off without `canClose`) and **Download CSV**.
- All copy through `app-i18n.ts`; no forbidden numbers; no physical-direction classes in `TodoPanel.tsx`.

- [ ] **Step 1: Write the failing tests (rule 509)**

```ts
describe("rule 509: the repeat controls and the series view", () => {
  it("a member sees no >Skip< and no >Stop repeat< when read-only; an admin sees Skip", () => {});
  it("a recurring row shows its badge with Latin digits in ar and en", () => {});
  it("the series view renders only that series' rows and reads only that set", () => {});
  it("the add form has no extra type=time and no role=switch; rule 487's counts still hold", () => {});
});
```

Use the `render` helper pattern from `tests/secretary-phase2.test.ts:50`.

- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement the components and wire up the page.**
- [ ] **Step 4: Run `npm run check` and look at the page in a browser.** Start the dev server through the preview tool; open `/ar/app/todo` and `/en/app/todo` as an admin and as a member, at 375 px and on desktop, with a recurring item and `?series=`.
- [ ] **Step 5: Add row 509 and commit.** `git commit -m "feat(reem): repeat controls and series history on My to-dos (rule 509)"`.

---

### Task 10: Reem's playbook, help, MCP copy, docs and spec amendments

**Files:**
- Modify:
  - `content/skills/secretary.md`: recurring items, away cards untouched, within the byte cap (about 4 KB of room left under 15,500).
  - `src/lib/help.ts`.
  - `src/components/app/McpPanel.tsx` and the MCP page: `repeat` and `stop_repeat` on `todo_create` and `todo_update`.
  - `src/lib/changelog.ts`: a new entry dated the day of merge (the A1 entry stays). No promised results, no invented numbers.
  - `docs/system/flows.md` §40 (A2), `permissions.md` (the two routes, a series-id row, the Reem items list, the counts), `architecture.md` §2.4 and §2.5, `tests.md` (rows 490-509 and the status header), `variables.md` (no variable added).
  - `docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md`: amend §4.1 (`time`), §4.2, §4.3 (R32-R35, R39, R41), §4.4, §5.1, §5.2 (R44) and §6 as the rulings say.

- [ ] **Step 1: Write the copy and docs.** Check that rule 206's pinned alert sentence and the secretary skill's byte cap tests still pass.
- [ ] **Step 2: Run `npm run check` and `npx next build`** (the build runs in CI if the local sandbox blocks it).
- [ ] **Step 3: Commit.** `git commit -m "docs(reem): recurring items and the series purge (spec amendments R32-R54)"`.
- [ ] **Step 4: Open a draft PR** whose description lists R32-R54 and the file-by-file summary. Do not merge. Wait for the founder's «ادمج».

After merge, on production: unauthenticated `PUT /api/secretary/series/<valid shape>/keep` answers 401 (the old build gives 404) and the to-do page shows the repeat control. Update the changelog date to the merge day if it differs.

---

## Dependencies

T1 → T2 → T3 → T4 → T5. T6 needs T3 (and T2 for the `until` check). T7 needs T4. T8 needs T7. T9 needs T3, T7 and T8. T10 comes last.

## Out of scope

- Calendars (part B), voice notes (roadmap), WhatsApp templates (wishlist), Telegram.
- Quiet days for the owner's own to-dos. Recurring series across brands. A way to edit a closed copy's rule.
