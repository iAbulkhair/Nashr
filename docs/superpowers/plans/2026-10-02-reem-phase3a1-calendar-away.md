# Reem phase 3 A1: work calendar, chase rule, away contacts — Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built (A1 is live per the 2026-10-02 decisions); PR number not looked up. The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reem stops suggesting the owner chase people on the brand's weekend, Eid, official holidays, outside Ramadan hours, and while a contact is away. The brand's admin sets the working days, and away contacts are recorded per person.

**Architecture:**
- A new server-only module, `secretary-calendar.ts`, turns the brand's settings (`sec:cal:{scope}`) and a per-country holiday table into `CalData`, a plain object.
- `CalData`, plus the away map (`sec:away:{scope}`, in `secretary-away.ts`), is passed into the import-pure `secretary-agenda.ts`. There, one rule, `chaseMoment`, decides when a debt is chaseable.
- Every surface that suggests chasing already reads the agenda, so the rule reaches all of them.

**Tech Stack:** Next.js 16 app router, TypeScript, Upstash Redis via `src/lib/db.ts` (in-memory store in tests), Vitest, ICU `Intl` (Umm al-Qura) in `src/lib/seasons.ts` only.

**Spec:** `docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md`, sections 1-3, 6, 7, 8 (A1), 9 and 11. Read it before starting: this plan argues from it.

## Global Constraints

**Isolation, auth and store**
- Every key comes from `sc(u)` (routes), `sc(user)` (tools) or the bearer's scope. Never build a key from a scope, email or id in a request body.
- Every route calls `currentUser()` first, then `forbid(u, action)`, then a rate limit from `allow()` in `src/lib/rate.ts`.
- No `await db.*` inside a loop. Use `Promise.all` or `pmap` from `src/lib/parallel.ts`.

**Calendar code**
- `Intl.DateTimeFormat` may be constructed only in `src/lib/dates.ts` and `src/lib/seasons.ts` (rule 37).
- `src/lib/secretary-agenda.ts` imports only `./dates`, `./agents` and `./zones` (client-bundle pin, `tests/client-bundle.test.ts`).
- Dates in UI and tool text use Latin digits (`dateFormat`, `ar-u-nu-latn`).

**Values copied from the spec**
- Ramadan default `[{ from: "10:00", to: "15:00" }]`.
- Away: cap of 200 fields; at most 366 days ahead; ended entries kept 7 days.
- `hijriFix`: only the current and next Hijri year, ±1 day.
- Holidays: `add` and `remove` at most 30 each.
- Weekend: 0-3 contiguous days.
- CalData memo: an LRU of 200 entries.
- Brief clock: `DAILY_CRON_UTC_HOUR = 5`.

**Product rules**
- No credits, no model call, and no invented numbers or promises in copy.

**Rules and tests**
- Rule numbers 470-489 belong to this PR. Add a "Reserved 490-509 for Reem phase 3 A2" row to `docs/system/tests.md`.
- Test files: `tests/secretary-calendar.test.ts` (Tasks 1-4 and 6) and `tests/secretary-away.test.ts` (Tasks 5 and 7-10). Each `describe` names its rule number.

**Commands**
- Before each commit: `npm run check`.
- Once for a fresh worktree: `npm ci --cache "$TMPDIR/npm-cache"` and `npx next typegen`.
- `npx next build` runs in CI. The local sandbox blocks it (fonts and port binding).

## Review Focus

Inputs the spec implies but no other task pins. Each line names the task that adds its test.

1. **A brand with no stored `timeZone` whose city or dialect changes through chat `update_brand`.** The country, weekend and holidays follow the new `zoneOf` on the next read, with no stale memo. → Task 3.
2. **An admin saves the calendar and the agenda is read in the same second.** The new settings apply at once, because the memo key hashes the calendar. → Task 8.
3. **Away labels with surrounding spaces, zero-width or soft-hyphen characters, or fullwidth Latin.** An item owed by «أحمد » matches the away entry «احمد», and «ＤＡＮＡ» is refused as an agent. → Task 7.
4. **Window edges.** A chase moment exactly at a window's `to` (15:00) is outside it, and one exactly at `from` (10:00) is inside. A chase exactly at `briefAt` on a working day is not moved. → Task 4.
5. **An empty weekend (`[]`).** Every non-holiday day is a working day, the week starts on Sunday, and `nextweek` lands on the next Sunday. → Task 2.

---

### Task 1: Hijri dates in the brand's zone

**Files:**
- Modify: `src/lib/seasons.ts`, `src/lib/secretary-evening.ts`, every `activeSeasons(` / `isRamadan(` caller (`grep -rn "activeSeasons(\|isRamadan(" src`)
- Test: `tests/secretary-calendar.test.ts` (new)

**Interfaces:**
- Produces, in `seasons.ts`:
  - `hijriDate(d: Date, zone?: Zone): { y: number; m: number; day: number }`, exported. It caches one formatter per zone, with `timeZone: zone` and year, month and day numeric.
  - `activeSeasons(now?: Date, zone?: Zone): Season[]`.
- Produces, in `secretary-evening.ts`:
  - `isRamadan(now: number, zone?: Zone): boolean`.
  - `eveningAt(now, zone, ramadan = isRamadan(now, zone))`.
  - `zonesDue(now, windowMs)`, which evaluates Ramadan per zone.
  - `previousEveningAt(now, zone)`, which uses the zone.
- `zone` defaults to `DEFAULT_ZONE` everywhere.

- [ ] **Step 1: Write the failing test (rule 470)**

```ts
describe("rule 470: Hijri dates follow the brand's zone, not the server's", () => {
  it("2027-03-09 is 1 Shawwal 1448 in Riyadh whatever TZ the process has", () => {
    for (const tz of ["UTC", "Asia/Riyadh", "America/New_York"]) {
      process.env.TZ = tz;
      expect(hijriDate(new Date("2027-03-08T21:30:00Z"), "Asia/Riyadh")).toEqual({ y: 1448, m: 10, day: 1 });
    }
  });
  it("the day flips at local midnight: 20:59Z on 2027-02-07 is still Sha'ban in Riyadh, 21:00Z is 1 Ramadan", () => {
    expect(hijriDate(new Date("2027-02-07T20:59:00Z"), "Asia/Riyadh").m).toBe(8);
    expect(hijriDate(new Date("2027-02-07T21:00:00Z"), "Asia/Riyadh")).toEqual({ y: 1448, m: 9, day: 1 });
  });
  it("isRamadan and the wrap time are per zone", () => {
    const t = Date.parse("2027-02-07T20:30:00Z"); // 00:30 in Dubai (Ramadan 1), 23:30 in Riyadh (Sha'ban 30)
    expect(isRamadan(t, "Asia/Dubai")).toBe(true);
    expect(isRamadan(t, "Asia/Riyadh")).toBe(false);
  });
});
```
Restore `process.env.TZ` in `afterEach`.

- [ ] **Step 2: Run it and see it fail.** Run `npx vitest run tests/secretary-calendar.test.ts`. Expected: FAIL, because `hijriDate` is not exported.
- [ ] **Step 3: Implement it in `seasons.ts` and `secretary-evening.ts`.**
  - The private `hijri()` delegates to `hijriDate(d, zone)`.
  - In `zonesDue`, replace the single `const ramadan = isRamadan(now)` with a per-zone call.
- [ ] **Step 4: Run it and `tests/secretary-phase2.test.ts`.** Expected: PASS. Rule 304's Ramadan tests still pass.
- [ ] **Step 5: Add the rule 470 row to `docs/system/tests.md` and commit.** `git commit -m "feat(reem): Hijri dates in the brand's zone (rule 470)"`.

---

### Task 2: Calendar primitives in the agenda module

**Files:**
- Modify: `src/lib/secretary-agenda.ts`, `src/lib/zones.ts`, `src/lib/secretary.ts` (`nextWeekStart`, `snoozePreset`)
- Test: `tests/secretary-calendar.test.ts`

**Interfaces:**
- Produces, in `secretary-agenda.ts` (pure, imports unchanged):
  - The `QuietWhy` and `CalData` types, exactly as spec §1.3.
  - `export type AwayMap = Record<string, { label: string; until: string; endedAt?: string }>`.
  - `defaultCal(zone: Zone): CalData`: the zone's weekend, no quiet days, no Ramadan days, the default Ramadan hours, and `briefAt` from `DAILY_CRON_UTC_HOUR`.
  - `isQuietDay(day: string, cal: CalData): boolean`: a weekend weekday, or a key in `cal.quiet`.
  - `addWorkingDays(ms: number, n: number, z?: Zone, cal?: CalData): number`. With `cal` it also skips `isQuietDay` days; without `cal`, it is unchanged.
  - `inRamadanWindow(ms: number, cal: CalData): boolean`. A window is `[from, to)`: `from` inclusive, `to` exclusive.
  - `firstWorkingMoment(t: number, cal: CalData): number`, as spec §2.1.
  - `nowLine(clock: number, z?: Zone, weekend?: number[])`, which names the week start from `weekStartDay(weekend)`.
- Produces, in `zones.ts`:
  - `weekStartDay(weekend: readonly number[]): number`: the day after the last weekend day of a contiguous run, or 0 when the run is empty.
  - `weekStart(z)` stays as a wrapper that returns the day name of `weekStartDay(ZONES[z].weekend)`.
- Produces, in `secretary.ts`:
  - `nextWeekStart(now, z, cal?)` and `snoozePreset(p, now, z, cal?)`, which use `cal.weekStart` when it is given.

- [ ] **Step 1: Write the failing tests (rule 471)**

```ts
describe("rule 471: working days, week start and windows from the brand calendar", () => {
  const riyadh = defaultCal("Asia/Riyadh");
  it("defaults match today's zone weekend", () => {
    expect(addWorkingDays(Date.parse("2026-10-01T09:00:00+03:00"), 2, "Asia/Riyadh", riyadh)).toBe(Date.parse("2026-10-05T09:00:00+03:00")); // Thu + 2 → Mon
  });
  it("a quiet day does not count", () => {
    const cal = { ...riyadh, quiet: { "2026-10-04": { kind: "holiday" as const } } };
    expect(addWorkingDays(Date.parse("2026-10-01T09:00:00+03:00"), 2, "Asia/Riyadh", cal)).toBe(Date.parse("2026-10-06T09:00:00+03:00"));
  });
  it("week start: Fri+Sat → Sunday, Sat+Sun → Monday, Fri only → Saturday, none → Sunday", () => {
    expect([weekStartDay([5, 6]), weekStartDay([6, 0]), weekStartDay([5]), weekStartDay([])]).toEqual([0, 1, 6, 0]);
  });
  it("an empty weekend: nextweek is the next Sunday 09:00", () => {
    const cal = { ...riyadh, weekend: [], weekStart: 0 };
    expect(snoozePreset("nextweek", Date.parse("2026-10-01T12:00:00+03:00"), "Asia/Riyadh", cal)).toBe("2026-10-04T06:00:00.000Z");
  });
  it("Ramadan windows are [from, to)", () => {
    const cal = { ...riyadh, ramadan: ["2027-02-20"] };
    expect(inRamadanWindow(Date.parse("2027-02-20T10:00:00+03:00"), cal)).toBe(true);
    expect(inRamadanWindow(Date.parse("2027-02-20T15:00:00+03:00"), cal)).toBe(false);
    expect(firstWorkingMoment(Date.parse("2027-02-20T15:00:00+03:00"), cal)).toBe(Date.parse("2027-02-21T10:00:00+03:00"));
  });
  it("briefAt on a working day is not moved", () => {
    expect(firstWorkingMoment(Date.parse("2026-10-04T08:00:00+03:00"), riyadh)).toBe(Date.parse("2026-10-04T08:00:00+03:00"));
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run `npx vitest run tests/secretary-calendar.test.ts -t "rule 471"`. Expected: FAIL (`defaultCal`, `weekStartDay` undefined).
- [ ] **Step 3: Implement it.**
  - `firstWorkingMoment(t)` loops at most 400 days, deciding as follows:
    1. If `t`'s day is quiet, move to `briefAt` on the next day.
    2. Otherwise, if the day is in `cal.ramadan` and `t` is not in a window, move to the next window start that day if there is one, else to `briefAt` on the next day, and re-check.
    3. Otherwise return `t`, unchanged even when it is before `briefAt`: only quiet days are moved to `briefAt`.
  - `nowLine` keeps its signature plus the optional `weekend`.
- [ ] **Step 4: Run it, then `npx vitest run tests/client-bundle.test.ts tests/secretary.test.ts`.** Expected: PASS, including the rule 209 and rule 300 pins.
- [ ] **Step 5: Add the rule 471 row and commit.** `git commit -m "feat(reem): calendar-aware working days and week start (rule 471)"`.

---

### Task 3: The work calendar module

**Files:**
- Create: `src/lib/secretary-calendar.ts`
- Test: `tests/secretary-calendar.test.ts`

**Interfaces:**
- Consumes:
  - `hijriDate` (Task 1);
  - `CalData`, `QuietWhy`, `defaultCal` and `weekStartDay` (Task 2);
  - `zoneOf` and `ZONES` (zones.ts);
  - the `SecFail` type from secretary.ts. Import the type only, to avoid an import cycle, and build failures locally as `{ ok: false, error, status, field? }`.
- Produces:
  - `type SecCalendar`, exactly as spec §1.1.
  - `type Country = "SA" | "AE" | "KW" | "QA" | "BH" | "OM"` and `countryOf(zone: Zone): Country`.
  - `COUNTRY_CAL: Record<Country, { fitr: EidRule; adha: EidRule; holidays: HolidayRule[]; compensation: "sa" | "next_working" | "none"; omanYear?: Record<number, string[]>; source: string }>`. `EidRule` and `HolidayRule` are internal types that encode spec §1.2's tables.
  - `parseCalendar(body: Record<string, unknown>, now: number, zone: Zone, login: string): { ok: true; cal: SecCalendar } | SecFail`.
    - Errors: `weekend_invalid`, `ramadan_hours_invalid`, `bad_year`, `hijri_fix_range`, `holidays_invalid`.
    - Unknown top-level fields give `bad_request`.
  - `workCalendar(cal: SecCalendar | null, zone: Zone, now: number): CalData`, memoised in an LRU of 200 entries, keyed by `${zone}|${zoneDay(now)}|${hash of cal without updatedAt/updatedBy}`.
  - `upcomingQuiet(cal, zone, now): { days: { day: string; why: QuietWhy }[]; ramadan: { start: string; end: string } | null }`. It covers the next 365 days.

- [ ] **Step 1: Write the failing tests (rules 472-474)**

```ts
describe("rule 472: Eid holidays per country (official private-sector spans)", () => {
  const q = (zone: Zone, day: string) => !!workCalendar(null, zone, Date.parse(`${day}T09:00:00Z`) - 30 * 864e5).quiet[day];
  it("13 Dhu al-Hijjah 1448 (2027-05-19) is quiet nowhere", () => { for (const z of ZONE_IDS) expect(q(z, "2027-05-19")).toBe(false); });
  it("29 Ramadan 1448 (2027-03-08) is quiet in Oman only", () => { for (const z of ZONE_IDS) expect(q(z, "2027-03-08")).toBe(z === "Asia/Muscat"); });
  it("30 Ramadan 1447 (2026-03-19, Thursday) is quiet in SA, AE and OM only", () => {
    const yes = new Set(["Asia/Riyadh", "Asia/Dubai", "Asia/Muscat"]);
    for (const z of ZONE_IDS) expect(q(z, "2026-03-19")).toBe(yes.has(z));
  });
});
```

Also write each case below as its own `it`, with the dates as assertions:

- **Rule 472, `hijriFix`:** with `shawwal1` set to "2027-03-10" for 1448 in Kuwait, 2027-03-09 is a Ramadan day and Fitr is 2027-03-10 to 2027-03-12.
- **Rule 473, holidays and compensation:**
  - QA: 2027-02-09 (2nd Tuesday of February) is quiet.
  - KW: 2026-08-25 (12 Rabi I 1448) is quiet.
  - SA: 2028-09-24 is quiet (National Day falls on a Saturday).
  - BH: 2023-12-18 is quiet (National Day falls on a Saturday).
  - AE: a National Day on a Saturday adds no day.
  - OM 2026: 11-25 and 11-26 are quiet, and 11-20 is not (the announced list).
  - `holidays.add` "2026-12-31" is quiet in 2026 only.
  - "H-09-27" is quiet every year.
  - Removing a default day makes it not quiet.
- **Rule 474, `parseCalendar` refusals:**

  | Input | Result |
  |---|---|
  | weekend [5, 1] or [0, 1, 2, 3] | `weekend_invalid` |
  | 3 Ramadan windows, "10:10", from ≥ to, overlapping windows | `ramadan_hours_invalid` |
  | `[]` as Ramadan hours | accepted |
  | `hijriFix` "1460" | `bad_year` |
  | a `hijriFix` date 2 days from the computed one | `hijri_fix_range` |
  | 31 entries in `add` | `holidays_invalid` |
  | an unknown top-level field | `bad_request` |

- [ ] **Step 2: Verify the source dates, then run and see it fail.**
  - Before encoding the table, run `node -e` with `Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "Asia/Riyadh" })` to confirm each Hijri date above.
  - Check each country row against the source cited in spec §1.2. Where an official source differs, fix the table (not the spec's intent) and cite the source in a comment.
  - Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement `secretary-calendar.ts`.**
  1. Build the 415-day window by computing `hijriDate` once for each local day (`zoneDay`, then a noon instant).
  2. Apply the Eid rules, the holidays, compensation (spec §1.2), and `holidays.add` / `remove`.
  3. **Compensation:**
     - `"sa"`: a Friday holiday also makes Thursday quiet, and a Saturday holiday also makes Sunday quiet.
     - `"next_working"`: the first following day that is neither weekend nor quiet.
  4. **Oman:** when `omanYear[gregYear]` is present, it replaces the decree-dated holidays (not the Eids) for that year.
- [ ] **Step 4: Run it.** Expected: PASS. Add the Review Focus 1 test here: a brand saved without `timeZone` and with city «دبي», then «الرياض». `workCalendar(null, zoneOf(brand), now).weekend` switches from `[6, 0]` to `[5, 6]`.
- [ ] **Step 5: Add the rule rows 472-474 and commit.** `git commit -m "feat(reem): per-country work calendar (rules 472-474)"`.

---

### Task 4: `chaseMoment` and the agenda

**Files:**
- Modify: `src/lib/secretary-agenda.ts` (`chaseAt`, `classify`, `computeAgenda`, `AgendaEntry`, `nextStepText`, new `partyKey`)
- Test: `tests/secretary-calendar.test.ts`

**Interfaces:**
- Consumes: `CalData`, `AwayMap`, `firstWorkingMoment`, `inRamadanWindow`, `isQuietDay` and `addWorkingDays` (Task 2).
- Produces:
  - `partyKey(label: string): string | null`, with the steps of spec §3.1. It returns null when the key is too long. It is pure; Task 7 imports it.
  - `chaseAt(it, z?, cal?)`.
  - `type ChaseMoment = { anchor: number; at: number; why: "normal" | "away" | "quiet" | "ramadan" }`.
  - `chaseMoment(it: SecItem, now: number, cal: CalData, away: AwayMap): ChaseMoment | null`, which is null for owner items.
  - `classify(it, now, z?, opts?: { cal?: CalData; away?: AwayMap })`, which returns `moment?: ChaseMoment` for items owed by a contact.
  - `AgendaEntry.moment?: ChaseMoment`.
  - `computeAgenda(items, now, opts: { approvals?; zone?; cal?; away? })`. Without `cal`, it uses `defaultCal(zone)`.
  - `nextStepText(e: Pick<AgendaEntry, "next" | "item" | "moment">, lang, z?, opts?: { quote?: boolean })`, which appends the spec §2.2 reason line. `itemLine` (secretary.ts) passes `quote: true`, so contact names reach agents as JSON-quoted data.
- `chaseMoment` follows spec §2.1, steps 1-7:
  - For an agent (`isAgentId(owedBy)`) it returns `{ anchor: base, at: base, why: "normal" }`.
  - An away entry applies when `until >= zoneDay(base)`. Then base = `firstWorkingMoment(zoneTime(addDays(until, 1), 0, 0, z))`.

- [ ] **Step 1: Write the failing tests (rules 475-477).** Write each case as one `it` with exact `toBe` / `toContain` assertions.

  **Rule 475:** `chaseMoment` moves chasing off quiet days, out of Ramadan's off-hours and past an absence.
  - Riyadh: due Friday 2026-10-02 10:00 gives `at` Sunday 2026-10-04 08:00, `why` "quiet". Due Thursday is unchanged, `why` "normal".
  - Dubai: due Saturday moves to Monday 09:00. Due Friday is unchanged.
  - Away: the entry `{ "احمد": until "2026-10-08" }` (a Thursday) in Riyadh, with an item owed by «أحمد » due 2026-10-05, gives `at` Sunday 2026-10-11 08:00, `why` "away".
  - Eid: with SA quiet days 2027-03-09 to 12, an item due 2027-03-10 moves to 2027-03-14 08:00.
  - A follow-up recorded on 2027-03-08 (Monday): the re-chase is the 2nd working day after Eid, 2027-03-15, at the follow-up's local time.
  - Ramadan, 2027-02-20: due 20:00 gives `at` 2027-02-21 10:00, `why` "ramadan". With windows 10-15 and 21:30-23:30, due 20:00 gives 21:30 the same day.
  - An item owed by "dana" (an agent) due on a Friday is not moved.

  **Rule 476:** a debt that is already chaseable waits on quiet days and outside Ramadan hours.
  - A chase due Wednesday 2027-03-03, with `now` Friday 2027-03-05 12:00 Riyadh: bucket `waiting`, `moment.why` "quiet", `moment.at` Sunday 08:00.
  - Ramadan: at 21:00 the item is `waiting` until 10:00 the next day. At 11:00 it is `chase`.
  - An owner item due on an Eid day is still `overdue` at Eid noon.

  **Rule 477:** `next` stays a string, and the reason line is shown.
  - `classify(...).next === "wait"` for an away item.
  - `nextStepText(e, "ar")` contains «غياب لين» and the date in Latin digits.
  - `nextStepText(e, "en")` contains "away until".
  - On an Eid day, a quiet item's line names «إجازة عيد الفطر».

  Also add Review Focus 4 here: in Ramadan, a moment exactly at 15:00 moves, and one exactly at 10:00 does not.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - `partyKey`.
  - `chaseAt(it, z, cal)`.
  - `chaseMoment`.
  - The `classify` branch for items owed by others (spec §2.2).
  - The `computeAgenda` options, and `moment` on entries.
  - The `nextStepText` reason lines. Reason names come from `QuietWhy.name`, or fixed words for `weekend` / `added`: «عطلة نهاية الأسبوع» / "the weekend" and «إجازة رسمية» / "a public holiday".
- [ ] **Step 4: Run it, `tests/secretary.test.ts` and `tests/secretary-brief.test.ts`.** Expected: PASS. Rules 197 and 209 still hold under the default calendar.
- [ ] **Step 5: Add the rule rows 475-477 and commit.** `git commit -m "feat(reem): one chase rule for quiet days, Ramadan hours and absences (rules 475-477)"`.

---

### Task 5: Read the calendar and the away map wherever the agenda or a date is computed

**Files:**
- Modify:
  - `src/lib/secretary.ts`: `SEC_KEYS.cal`, `SEC_KEYS.away`, `calFor`, `agendaFor`, `createItem`, `changeItem`, `mutateItem`, `defaultExpectBy`, `parseOwnerChange`, `secretaryKeys`.
  - `src/lib/secretary-evening.ts`: `buildWrap`.
  - `src/app/api/secretary/[id]/route.ts`.
  - `src/lib/chat.ts`: `chat()`'s reads, and `system()` → `nowLine`.
- Test: `tests/secretary-away.test.ts` (new)

**Interfaces:**
- Consumes: `workCalendar` (Task 3), `computeAgenda` opts (Task 4).
- Produces:
  - `SEC_KEYS.cal(scope) = sec:cal:${scope}` and `SEC_KEYS.away(scope) = sec:away:${scope}`.
  - `calFor(scope: string, now?: number): Promise<{ zone: Zone; cal: CalData; away: AwayMap }>`. It reads the brand, `sec:cal` and `sec:away` in one `Promise.all`, and maps the away hash to `AwayMap`.
  - `agendaFor` uses `calFor` in place of `zoneFor`, inside its existing `Promise.all`.
  - `mutateItem(it, c, who, now, z, cal?)`, `defaultExpectBy(now, z, cal?)` and `parseOwnerChange(b, now, z, cal?)`.
  - `buildWrap` passes `{ zone, cal, away }` to both of its `computeAgenda` calls.
  - `secretaryKeys` lists both new keys.

- [ ] **Step 1: Write the failing tests (rule 478)**
  - `agendaFor` costs the same number of store calls for 3 and for 40 items. Extend rule 198's spy (tests/secretary.test.ts:504-530) to the new reads; the counts stay equal between 3 and 40.
  - In a Saudi brand with Eid on 2027-03-09 to 12, a they-owe item created Thursday 2027-03-04 gets `expectBy` Monday 2027-03-08. One created Sunday 2027-03-07 gets `expectBy` 2027-03-14.
  - In a Dubai brand, `buildWrap`'s "tomorrow" leaves out a chase whose contact is away.
  - `wipeAccount` removes `sec:cal:{scope}` and `sec:away:{scope}` (extends rules 201 and 306).
  - `system()` for a brand with weekend `[5]` says "The work week starts on Saturday".
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the plumbing as listed.** The PATCH route calls `calFor(scope)` once and passes `zone` and `cal`.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Add the rule 478 row and commit.** `git commit -m "feat(reem): read the work calendar wherever dates are computed (rule 478)"`.

---

### Task 6: Alerts and the morning brief

**Files:**
- Modify: `src/lib/secretary-agenda.ts` (`overdueAlerts`, `briefAgenda`, new `workingDaysBetween`), `src/lib/secretary.ts` (`overdueAlertFingerprint`), `src/lib/notifications.ts` (`overdueTodoAlerts`)
- Test: `tests/secretary-calendar.test.ts`

**Interfaces:**
- Consumes: `AgendaEntry.moment`, `CalData`, `isQuietDay` and `inRamadanWindow`; `agendaFor` with `cal` (Task 5).
- Produces:
  - `workingDaysBetween(a: string, b: string, cal: CalData): number`: the non-quiet days in `(a, b]`.
  - `overdueAlerts(entries: AgendaEntry[], now: number, z: Zone, cal: CalData): { entry; days; step; anchorMs; ramadanToday?: string }[]`:
    - Owner entries keep today's calendar-day logic from `dueAt`.
    - Entries owed by others count `workingDaysBetween(zoneDay(anchor), today, cal)`, and give `[]` when today is quiet.
    - A `waiting` entry with `why === "ramadan"` and `at` today is returned with step 0 and `ramadanToday = "HH:mm"`.
  - `overdueAlertFingerprint(scope, id, anchorMs: number, step)`. Owner items pass `Date.parse(dueAt)`, so their string is unchanged.
  - `backFingerprint(scope, id, until) = todo-back:${scope}:${id}:${until}`.
  - `overdueTodoAlerts`:
    - passes `[...overdue, ...chase (others only), ...waiting with why "ramadan"]`;
    - claims the back fingerprint with `setNx` (7 days) when the item's away entry has `endedAt` within 7 days;
    - uses the spec §2.3 texts.
  - `briefAgenda(a)`: `chase` also counts `waiting` entries whose `moment.why === "ramadan"` and whose `at` falls today.

- [ ] **Step 1: Write the failing tests (rules 479-480)**
  - An undated they-owe item alerts on its anchor's day, at step 0.
  - No step alert is sent on a Friday in Riyadh. The step-1 alert for a Thursday chase comes on Sunday.
  - In Ramadan, at the 08:00 run, an item chase-due at 10:00 is alerted with «تابعه اليوم بعد 10:00».
  - Over steps 0-3 after an absence, «انتهى غياب» appears exactly once.
  - Ending an absence early (DELETE) produces the back alert.
  - Owner items keep today's fingerprint string `todo-due:{scope}:{id}:{dueMs}:{step}`.
  - The brief's `chase` count includes the Ramadan item at 08:00.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS. The rule 200 pin (`tests/secretary-brief.test.ts`) still holds for owner items. Update it only where the spec changes the steps for items owed by others.
- [ ] **Step 5: Add the rule rows 479-480 and commit.** `git commit -m "feat(reem): alerts count working days and wait for Ramadan hours (rules 479-480)"`.

---

### Task 7: Away contacts: store, rules and routes

**Files:**
- Create: `src/lib/secretary-away.ts`, `src/app/api/secretary/away/route.ts`
- Modify: `src/lib/secretary.ts` (`secretaryDaily` clean-up)
- Test: `tests/secretary-away.test.ts`

**Interfaces:**
- Consumes: `partyKey` (Task 4), `SEC_KEYS.away` (Task 5), `withLock(scope, "away", fn)`, `audit`, `cleanLine`, `party()` and `isAgentId`.
- Produces:
  - `AWAY_MAX = 200`, `AWAY_AHEAD_DAYS = 366`, `AWAY_KEEP_DAYS = 7`.
  - `type AwayEntry = { label: string; until: string; note?: string; by: string; via: "web"; at: string }`.
  - `setAway(scope, raw: { label: unknown; until: unknown; note?: unknown }, who: Who, now: number, zone: Zone): Promise<{ ok: true; entry: AwayEntry } | SecFail>`. Errors: `not_contact`, `too_long`, `away_range`, `away_limit`, `bad_request`.
  - `endAway(scope, label: unknown, who, now, zone)`: sets `until` to yesterday.
  - `listAway(scope, now, zone): Promise<(AwayEntry & { ended: boolean })[]>`.
  - `cleanAway(scope, now, zone): Promise<number>`: removes fields more than 7 days past, in one `Promise.all` of `db.hdel`.
  - The routes:

    | Method | Role | Rate |
    |---|---|---|
    | `GET` | `read` | `sec:read` |
    | `PUT` | `todo.write` | `sec:write` |
    | `DELETE` | `todo.write` | `sec:write` |

    Each route authenticates, then checks the role, then the rate limit, then reads the JSON body. It reads only `label`, `until` and `note` from the body.

- [ ] **Step 1: Write the failing tests (rules 481-483)**

  **Rule 481: matching.**
  - `partyKey` maps «أحمد», «احمد», «إحمد», «أحمد » and «أح­مد» to one key.
  - «ＤＡＮＡ», "owner", «أنا» and "reem" give `not_contact`.
  - An 81-character key gives `too_long`.
  - An item owed by «احمد» shows as away when the entry is «أحمد».

  **Rule 482: limits.**
  - `until` today + 367 gives `away_range`, and so does yesterday.
  - The 201st field gives `away_limit`, even when earlier entries have ended.
  - Two concurrent PUTs at 199 fields leave at most 200.
  - The note goes through `cleanLine` and is at most 200 characters.
  - DELETE keeps the field, with `until` set to yesterday.
  - `cleanAway` removes only fields more than 7 days past.
  - Every write leaves an `away` or `away_end` audit line.

  **Rule 483: routes.**
  - Unauthenticated requests get 401.
  - A member can PUT and DELETE.
  - The rate limits apply.
  - A PUT in brand A never touches brand B's hash.
  - GET lists ended entries with `ended: true`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.** `secretaryDaily` calls `cleanAway` next to `purgeExpired`, in parallel.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Add the rule rows 481-483 and the permissions rows, and commit.** `git commit -m "feat(reem): away contacts with a page route (rules 481-483)"`.

---

### Task 8: The Working days route

**Files:**
- Create: `src/app/api/secretary/calendar/route.ts`
- Test: `tests/secretary-away.test.ts`

**Interfaces:**
- Consumes: `parseCalendar`, `workCalendar` and `upcomingQuiet` (Task 3); `SEC_KEYS.cal`, `withLock`, `audit` and `calFor` (Task 5).
- Produces:
  - `GET` (`read`, rate `sec:read`): `{ ok, calendar: SecCalendar | null, effective: { country, weekend, weekStart, ramadanHours }, upcoming }`.
  - `PUT` (`brand.write`, rate `allow("sec:cal:{email}", 30, 3600)`): runs `parseCalendar`, then saves under `withLock(scope, "cal")` with a `calendar` audit line.

- [ ] **Step 1: Write the failing tests (rule 484)**
  - A member's PUT gets 403.
  - An admin's PUT gets 200, and the saved JSON equals the parsed body plus `updatedAt` and `updatedBy`.
  - The 31st PUT in an hour gets 429.
  - Unauthenticated requests get 401.
  - GET in a Saudi brand lists 2026-09-23 with the name «اليوم الوطني».
  - Review Focus 2: PUT weekend `[5]`, then in the same test `agendaFor` classifies a Saturday chase as `chase`, not `waiting`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the route.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Add the rule 484 row and the permissions rows, and commit.** `git commit -m "feat(reem): working days settings route (rule 484)"`.

---

### Task 9: `contact_away` from Reem's chat: a card a person saves

**Files:**
- Create: `src/app/api/secretary/away/proposals/[id]/route.ts`
- Modify:
  - `src/lib/secretary-away.ts`: proposals.
  - `src/lib/chat.ts`: the tool definition, `toolsFor`, `runTool`, `ToolCtx.awayProposed`, `ChatMsg.awayProposals`, `turnParts`.
  - `src/components/app/ChatPanel.tsx`: the card.
  - `secretaryKeys`: the proposal keys.
- Test: `tests/secretary-away.test.ts`

**Interfaces:**
- Consumes: `setAway` and `endAway` (Task 7); the `brand-proposals.ts` pattern (a random 16-hex id, a record with a 7-day TTL, an index set for the account wipe).
- Produces:
  - `type AwayProposal = { id: string; label: string; key: string; until: string | null /* null = end */; openItems: number; at: string; state?: "open" | "saved" | "dismissed" | "expired" }`.
  - `proposeAway(scope, input, now, zone): Promise<{ ok: true; p: AwayProposal } | SecFail>`:
    - validates the input like `setAway`;
    - counts the open items owed by that key, from `listOpenItems`;
    - stores `secawayprop:{scope}:{id}` (TTL 7 days) and adds the id to the set `secawayprops:{scope}`.
  - `decideAwayProposal(scope, id, action: "save" | "dismiss", who): Promise<{ ok: true; entry?: AwayEntry } | SecFail>`. It claims `secawayprop-done:{scope}:{id}` with `setNx`.
  - `CONTACT_AWAY_TOOL`, an Anthropic tool with `name`, `until` ("YYYY-MM-DD") or `clear: true`. Its description is as spec §3.2.
  - `toolsFor(agentId)` adds the tool when `agentId === "reem"`.
  - `runTool`, case `"contact_away"`:
    - it refuses unless `ctx.agent === "reem"`, `ctx.via !== "mcp"`, and neither `ctx.by?.kind` nor `user.actor?.kind` is `"token"`;
    - otherwise it pushes into `ctx.awayProposed` and returns the sentence "Proposed, not saved: … the owner presses Save on the card."
  - The route `POST /api/secretary/away/proposals/{id}` with `{ action: "save" | "dismiss" }`:
    - role `todo.write`, rate `sec:write`;
    - the id must match `/^[a-f0-9]{16}$/`;
    - the proposal is read only from `sc(u)`.
  - `ChatPanel` renders `m.awayProposals` with Save and Dismiss, in the style of the brand `ProposalCard`.

- [ ] **Step 1: Write the failing tests (rules 485-486)**

  **Rule 485:**
  - `runTool(user, "contact_away", …, { agent: "reem", via: "app" })` writes nothing to `sec:away` and returns one proposal.
  - Save through the route writes the entry.
  - A second Save is refused (already claimed).
  - A member can Save.
  - Another brand's id gives 404.

  **Rule 486:**
  - `runTool` refuses `contact_away` for `agent: "noor"`, for `via: "mcp"` and for a token actor, and writes nothing.
  - `toolsFor("noor")` and the MCP tool list do not contain it. `toolsFor("reem")` does.
  - `CHAT_TOOL_NAMES` (the shared tools) does not contain it.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.** `wipeAccount` removes `secawayprops:{scope}` and every `secawayprop:{scope}:{id}` it names. Extend rules 201 and 306 to these keys.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Add the rule rows 485-486 and commit.** `git commit -m "feat(reem): absences proposed in chat are saved by a person (rules 485-486)"`.

---

### Task 10: The to-do page: Working days, Away, and the reason line

**Files:**
- Modify:
  - `src/app/[lang]/app/todo/page.tsx`: load `calFor`, `listAway` and `upcomingQuiet`, and pass `canCal = can(u, "brand.write")`.
  - `src/components/app/TodoPanel.tsx`.
  - `src/lib/app-i18n.ts`: the strings, in Arabic and English.
- Create: `src/components/app/WorkingDaysPanel.tsx`, `src/components/app/AwayPanel.tsx`
- Test: `tests/secretary-away.test.ts`

**Interfaces:**
- Consumes: the routes of Tasks 7-8, and `nextStepText` (Task 4) for the row line.
- Produces:
  - `TodoRow.reason?: string`. When it is set, the row shows it under the WhatsApp link.
  - `WorkingDaysPanel`, with props `{ t, lang, calendar, effective, upcoming, canEdit, cityHint: boolean }`. It contains:
    - the weekend editor, with the country's default marked;
    - Ramadan hours, at most 2 windows;
    - this year's and next year's Eid, with "a day later / earlier" buttons that write `hijriFix`;
    - the holidays, with on/off switches, "add a day for this year only" and "add a yearly day";
    - the label «متوقعة — تأكد من الإعلان الرسمي».

    Members see the panel read-only.
  - `AwayPanel`, with props `{ t, lang, entries, labels: string[] }`: the list with "End now", and an add form whose name field has a `<datalist>` of `labels`.
  - Rows owed by a contact get an "Away until…" action. It opens `AwayPanel`'s form with the name pre-filled.

- [ ] **Step 1: Write the failing render tests (rule 487)**
  - Rendered in Arabic for an admin, the page contains «أيام العمل», «الغائبون» and «متوقعة — تأكد من الإعلان الرسمي».
  - Rendered for a member, the weekend inputs are `disabled`.
  - An item owed by an away contact renders «غياب لين», with Latin digits.
  - A Sharjah brand renders the Friday hint.

  Use the `render` helper pattern from `tests/secretary-phase2.test.ts:50`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the components and wire up the page.** All copy goes through `app-i18n.ts`, with no invented numbers.
- [ ] **Step 4: Run `npm run check` and check the page in a browser.** Expected: PASS. Then start the dev server through the preview tool and look at `/ar/app/todo` and `/en/app/todo` as an admin and as a member, at 375 px and on desktop.
- [ ] **Step 5: Add the rule 487 row and commit.** `git commit -m "feat(reem): working days and away panels on My to-dos (rule 487)"`.

---

### Task 11: Reem's playbook, help, MCP copy and system docs

**Files:**
- Modify:
  - `content/skills/secretary.md`: the Gulf adaptations; the alert sentence pinned by rule 206 (kept with its test); away proposals.
  - `src/lib/help.ts`.
  - `src/components/app/McpPanel.tsx`: line 99's "Riyadh time" becomes "the brand's time". Nothing new reaches MCP in A1.
  - `src/lib/changelog.ts`.
  - `docs/system/architecture.md`: the modules `secretary-calendar.ts` and `secretary-away.ts`, and the keys `sec:cal`, `sec:away` and `secawayprop*`.
  - `docs/system/flows.md`: a new §39, including Oman's January list update as a maintenance step.
  - `docs/system/permissions.md`: the routes and the Reem items.
  - `docs/system/tests.md`: the status line, rules 470-489, and the reserved row 490-509.
  - `docs/system/variables.md`: one sentence saying A1 added no variable.
- Test: `tests/secretary.test.ts` (rule 206's sentence pins); `tests/home-copy.test.ts` if that copy changes.

**Interfaces:**
- Consumes: everything above.
- Produces: docs that match the code.

- [ ] **Step 1: Write the failing pins (rules 488-489)**
  - **Rule 488:** `secretary.md` says that Reem proposes an absence only from the owner's own words and that a person saves it, and it does not promise an alert on a weekend day.
  - **Rule 489:** every key in `SEC_KEYS`, and every `secawayprop` key family, appears in `architecture.md`'s key table. Extend the existing key-table test if there is one; otherwise add it.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the docs and the copy.**
  - Run `grep -o "^| [0-9]* |" docs/system/tests.md | sort | uniq -d`. It must print nothing.
  - Re-read every `path:line` reference the docs cite.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS. CI runs `npx next build` after the push.
- [ ] **Step 5: Commit, push and open a draft PR.**
  - Commit: `git commit -m "docs(reem): phase 3 A1 playbook, help and system docs (rules 488-489)"`, then push the branch.
  - Open a **draft** PR, "Reem phase 3 A1: work calendar and away contacts". Its body lists rules 470-489 and the after-merge checks of spec §11.
  - Do not merge. The founder approves the merge explicitly.
