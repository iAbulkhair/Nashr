# Reem, the secretary — phase 3 part A: work calendar, away contacts, recurring items (2026-10-02)

Builds on phase 1 (`2026-09-29-secretary-reem-phase1.md`, PR #225) and phase 2 (`2026-09-30-secretary-reem-phase2.md`,
PR #231), whose "out of scope" list this part takes from. Written from the founder's answers of 2026-10-02, then
revised the same day after an adversarial review of the first draft (47 findings, 46 confirmed: code facts, design
holes, security, official holiday dates, fidelity) and four further founder answers.

## Founder decisions (2026-10-02)

**Scope and order**
- **A (this spec):** the brand's work calendar (quiet days), contacts who are away, and recurring items.
- **B (next spec):** calendars, meaning a subscription feed for iPhone, Google and Outlook; Calendly and Cal.com; and reading Google and Outlook busy times.
- **Postponed:**
  - voice notes, to the feature roadmap (research kept in memory);
  - WhatsApp utility templates, to the wishlist.

**Recurring items**
- One open copy per series. Closing it opens the next one on its next scheduled date, and missed dates do not pile up.
  - Exception (founder): if a closed copy is reopened while its next copy is open and was already edited, both stay open, with a note.
- Patterns:
  - daily;
  - working days only;
  - weekly on chosen weekdays;
  - monthly on a day number or on the last day;
  - every N days, weeks or months;
  - yearly (Gregorian);
  - monthly and yearly Hijri (Umm al-Qura).
- Created by the owner on the page, by Reem in chat, and by the owner's MCP assistant, when the owner asks.
- Closed copies of a series are deleted 90 days after they close. The customer is warned at least a week before, can keep a series' history ("keep history"), and can download it as CSV.

**Quiet days and away contacts**
- They pause only the chasing of others. The owner's own to-dos and the reminders the owner set keep working. A chase that falls on a quiet day moves to the next working day.
- **Weekend:** the country's default (Fri+Sat; Sat+Sun in the UAE), and each brand may change it.
- **Eid:** each country's official private-sector Eid holiday, computed with Umm al-Qura in the brand's zone. The owner can move an Eid's days for a given year.
- **Other official holidays:** every official holiday of the brand's country is quiet: national days, Founding Day, Hijri New Year, the Prophet's Birthday, 1 January, and others. The owner can remove or add days, Hijri or Gregorian, for one year or every year.
- **Ramadan:** chasing is suggested only inside the brand's Ramadan hours, pre-filled as 10:00-15:00. The customer changes them.
- **Away:** one setting per contact, across all of that contact's items.
  - Set on the page by any member with the to-do write permission.
  - From chat, Reem proposes it on a card and a person presses Save.
  - Other agents, MCP and connector data cannot set it.

**Rules kept from phases 1 and 2**
- Every key comes from `sc(u)` (or the bearer's scope).
- Ids are format-checked.
- Writes run under the item lock with `rev`.
- No `await db.*` inside a loop.
- Nothing costs credits or calls a model.
- The owner closes and agents propose.

No new environment variable. Everything works without QStash.

## Delivery

Two pull requests, on branches, merged only with the founder's explicit approval:

- **PR A1:** sections 1-3 (calendar, chase rule, away). Rules 470-489, flows §39.
- **PR A2:** sections 4-6 (recurring items, closed-copy deletion). Rules 490-509, flows §40.
  - A2 branches from A1 and is opened only after A1 is merged to main.
  - It uses A1's `CalData`, `hijriDate` and effective week start.

Rules up to 464 are taken on main (PR #240 merged); 465-469 stay free as a buffer. A1 adds a "Reserved 490-509 for Reem phase 3 A2" row to `docs/system/tests.md`. Before each merge, re-check `tests.md` and the open PRs for taken or duplicated numbers.

---

## 1. The brand's work calendar (A1)

### 1.1 Settings: `sec:cal:{scope}`

One JSON value (absent = all defaults):

```ts
type SecCalendar = {
  v: 1;
  /** Weekend weekdays, 0 = Sunday … 6 = Saturday: 0 to 3 days, unique and contiguous (wrapping Sat→Sun allowed),
   *  else `weekend_invalid`. null = the zone's default (zones.ts). */
  weekend: number[] | null;
  /** Ramadan chasing hours, local time. null = the default [{ from: "10:00", to: "15:00" }]; [] = no restriction.
   *  At most 2 windows, "HH:mm" on a 15-minute step, from < to, same day, no overlap, else `ramadan_hours_invalid`. */
  ramadanHours: { from: string; to: string }[] | null;
  /** Per Hijri year, the owner's corrections when the country's sighting differs from Umm al-Qura. Keys "1448" etc.,
   *  only the current and the next Hijri year (else `bad_year`). Each date within ±1 day of the computed one. */
  hijriFix: Record<string, { ramadan1?: string; shawwal1?: string; dhulhijja1?: string }>;
  /** Changes to the country's holidays. Values: "MM-DD" (Gregorian, every year), "YYYY-MM-DD" (that day only),
   *  "H-MM-DD" (Hijri, every year), "H-YYYY-MM-DD" (that Hijri day only). `remove` takes only days the defaults
   *  produce. At most 30 values in `add` and 30 in `remove`, else `holidays_invalid`. */
  holidays: { add: string[]; remove: string[] };
  updatedAt: string;
  updatedBy: string; // login of the admin who saved
};
```

- **Eid moves and per-year corrections.** These go through `hijriFix` and `holidays`:
  - Moving Eid by a day is a `hijriFix.shawwal1` or `dhulhijja1` change. All Hijri dates of that month move with it.
  - Adding or removing a single day is an `add` or `remove` entry for that day.
- **Amended 2026-10-03 (ruling R8, as built):** stale values are dropped on save, not refused, so settings read from a GET and saved back unchanged still save: a `hijriFix` year before the current Hijri year, and a dated `add` or `remove` value ("YYYY-MM-DD", "H-YYYY-MM-DD") before today-30, the calendar's first day (today-14 until ruling R17). Only a year after the next Hijri year is `bad_year`. The calendar ignores such values too.
- **Amended 2026-10-03 (ruling R26, as built): the Saudi Eid al-Fitr start.** "The day after 29 Ramadan" is the day before the effective 1 Shawwal when Ramadan, counted from its Umm al-Qura start to that 1 Shawwal, ran 30 days or more, else the effective 1 Shawwal; the UAE's Eid al-Fitr, which adds 30 Ramadan in a 30-day month, starts the same way. Without a correction this is what it always was. With Eid announced a day after a 30-day Umm al-Qura Ramadan, the holiday starts a day later too; after a 29-day one it does not move, because the law anchors it to 29 Ramadan. No corrected Ramadan runs past 30 days: when the corrections would make it 31, its start moves a day later instead. The Working days panel shows each Eid's days off, and tells a Saudi brand why Eid al-Fitr's may not move.
- **Amended 2026-10-03 (ruling R28, as built): removals stay stored.** `remove` takes a new value only when a default day of the coming calendar window matches it; a value already in the stored record's `remove` list is kept even when no default produces it any more (the Eid was moved a day, the brand's zone changed country), so a save never deadlocks the panel (PUT reads the stored record under `withLock(scope, "cal")` and `parseCalendar(body, now, zone, login, stored)` accepts what it holds). The calendar ignores such a stale removal; the panel lists it under "Days you turned off", where it can be turned on, which drops it. Only a new removal that matches nothing is `holidays_invalid`. Ruling R8 still drops a dated value before today-30.
- **Amended 2026-10-03 (ruling R30, as built): `ramadan1` is not taken.** `hijriFix` takes `shawwal1` and `dhulhijja1` only, the two the Working days panel writes. A new `ramadan1` is refused (`bad_request`, field `hijriFix.{year}.ramadan1`); one stored before this is dropped when the settings are saved back as GET gave them (like ruling R8), and the calendar no longer reads it, so Ramadan always starts on Umm al-Qura's day and the 31-day clamp of ruling R26 can never undo a correction. Until a panel control exists, Ramadan hours may start a day off where the local sighting differs from Umm al-Qura. Stored Ramadan hours are checked again when the calendar is built (the same parser as on save); hours that are not valid windows read as the default, so a hand-edited record cannot stop the agenda.
- **What the Working days panel offers** (section 1.4): "Eid starts a day later this year" and "add a day for this year only".
- **The calendar is computed** (section 1.3) from the zone default, plus the brand's settings, plus the country table (section 1.2).

### 1.2 The country table (`src/lib/secretary-calendar.ts`)

The country comes from the zone:

| Zone | Country |
|---|---|
| Riyadh | SA |
| Dubai | AE |
| Kuwait | KW |
| Doha | QA |
| Manama | BH |
| Muscat | OM |

Each country has:
- its official **private-sector** holidays, each with an id and an Arabic and English name;
- a `compensation` rule;
- the source cited in the code.

The values below came out of the review's sources. They are checked again against the cited sources when A1 is built, and any difference is fixed in the table with its source. Government-sector breaks, which are often longer, are not the default.

**Eid**

Here "1 Shawwal" and "1 Dhu al-Hijjah" mean the effective dates, after any `hijriFix`.

| Country | Eid al-Fitr | Eid al-Adha | Source |
|---|---|---|---|
| SA | 4 days starting the day after 29 Ramadan (read as ruling R26 in §1.1) | 9-12 Dhu al-Hijjah (Arafah + 3) | Labour Law executive regulations art. 24 (HRSD) |
| AE | 1-3 Shawwal, plus 30 Ramadan when the month has 30 days | 9 (Arafah), 10-12 | Cabinet Resolution 27/2024 (u.ae) |
| OM | 29 Ramadan to 3 Shawwal | 9-12 | Royal Decree 88/2022 |
| KW | 1-3 Shawwal | 9 (Arafah), 10-12 | Law 6/2010 art. 68 |
| BH | 1-3 Shawwal | 9-12 | Bahrain official list |
| QA | 1-3 Shawwal | 10-12 | Law 14/2004 art. 78 |

**Other official holidays** (the defaults)

| Country | Holidays |
|---|---|
| SA | Founding Day 02-22 «يوم التأسيس»; National Day 09-23 «اليوم الوطني» |
| AE | 01-01; Hijri New Year (H 01-01); Prophet's Birthday (H 03-12); National Day 12-02 and 12-03 (Commemoration Day is not a day off) |
| KW | 01-01; H 01-01; Isra and Mi'raj (H 07-27); H 03-12; National Day 02-25; Liberation Day 02-26 |
| BH | 01-01; Labour Day 05-01; H 01-01; Ashura (H 01-09 and H 01-10); H 03-12; National Day 12-16 and 12-17 |
| QA | National Sport Day (2nd Tuesday of February); National Day 12-18 |
| OM | Decree dates: Accession Day 01-11; H 01-01; H 03-12; H 07-27; National Day 11-20 and 11-21 (RD 15/2025 amending RD 88/2022) |

**Oman's announced list.** Oman announces the days actually taken each January and moves them. The table therefore also holds Oman's announced list for the current year (2026: 01-15, 01-18, 06-18, 08-27, 11-25, 11-26), and that list replaces the decree dates for that year. Updating the list each January is a maintenance step written in `docs/system/flows.md` §39.

**Compensation for a holiday that falls on the weekend**

| Country | Rule |
|---|---|
| SA | A Friday holiday also makes Thursday quiet, and a Saturday holiday makes Sunday quiet (art. 24) |
| BH, QA, OM | The next working day is quiet |
| AE, KW | None |

**Amended 2026-10-03 (rulings R4 and R4a, as built):** `COUNTRY_CAL` in `src/lib/secretary-calendar.ts` holds the values as checked against each cited source on 2026-10-02, and the source won where it differed from the tables above: Saudi Arabia also compensates Eid days that fall on the weekly rest (an Eid's days in lieu go after it; a one-day holiday's to the nearer side of the weekend), so every Saudi Eid has days in lieu; Bahrain's private sector has no Arafah day (Eid al-Adha 10-12) and compensates a Friday, and a holiday on another holiday, but not a Saturday; Oman compensates an Eid only when its first day (1 Shawwal or 10 Dhu al-Hijjah) is a Friday, and another holiday once when it has weekend days; Qatar's "working days" put a weekend day, and a holiday on another holiday, on the next working day. Each row's `source` says what was read and when.

**Calendar for every country:** Umm al-Qura, corrected per year by `hijriFix`.

### 1.3 Computing quiet days (server only)

`src/lib/secretary-calendar.ts` is server-only. It never constructs `Intl.DateTimeFormat` itself. Rule 37 allows that only in `dates.ts` and `seasons.ts`, and the client-bundle pin keeps `secretary-agenda.ts` import-pure.

**`seasons.ts` changes**
- It exports `hijriDate(d: Date, zone: Zone = DEFAULT_ZONE): { y: number; m: number; day: number }`, built on one cached `Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { year, month, day: "numeric", timeZone: zone })` per zone.
- The private `hijri` and `activeSeasons(now, zone = DEFAULT_ZONE)` use it. The Hijri day then flips at local midnight in the brand's zone. Today it follows the process zone, which on Vercel (UTC) flips it at 03:00 Riyadh.

**Evening wrap changes:** `isRamadan(now, zone = DEFAULT_ZONE)` in `secretary-evening.ts` takes the zone. `eveningAt`, `previousEveningAt` and `zonesDue` pass each zone's own value.

**`workCalendar(cal, zone, now)`** returns `CalData`, a plain, serialisable object:

```ts
type QuietWhy = { kind: "weekend" | "eid_fitr" | "eid_adha" | "holiday" | "added"; name?: { ar: string; en: string } };
type CalData = {
  zone: Zone;
  weekend: number[];                       // effective
  weekStart: number;                       // the day after the last weekend day; Sunday when there is none
  quiet: Record<string, QuietWhy>;         // non-weekend quiet local days, today-30 … today+400 (amended 2026-10-03, ruling R17: 14 before)
  ramadan: string[];                       // local days of Ramadan (effective, with hijriFix), same window
  ramadanHours: { from: string; to: string }[]; // effective
  briefAt: { hh: number; mm: number };     // 08:00 at UTC+3, 09:00 at UTC+4 (DAILY_CRON_UTC_HOUR)
};
```

- **Cost:** about 501 `hijriDate` calls, one per local day from today-65 to today+435 (the window today-30 … today+400 and 35 days more on each side), CPU only, with no store call. (Amended 2026-10-03, as built: the 415 written here first counted only today-14 … today+400, before ruling R17 and without the margins.)
- **Memo:** a module-level LRU of at most 200 entries, keyed by (zone, local day, a hash of the calendar without `updatedAt`/`updatedBy`).

### 1.4 Where `CalData` is read

| Caller | How it gets `CalData` |
|---|---|
| `agendaFor` | `db.get(sec:cal)` and `db.hgetall(sec:away)` (section 3) join its existing `Promise.all`. This is a constant 2 extra calls, so rule 198 still holds and its call counts are updated deliberately. |
| `buildWrap` | Receives the same `CalData` and away map for both of its `computeAgenda` calls. |
| `createItem` and `changeItem` | Read `sec:cal` in the same round as the zone. They pass `CalData` to `mutateItem(it, c, who, now, z, cal)` and `defaultExpectBy(now, z, cal)`. The chat and MCP tools reach these through the two functions. |
| PATCH route | Reads it with `zoneFor` and passes it to `parseOwnerChange(b, now, z, cal)`, then to `snoozePreset` and `nextWeekStart`. |
| `chat()` | Adds `db.get(sec:cal)` to its existing `Promise.all`. `system()` passes the effective weekend to `nowLine`, which names the week start. |

`weekStart(z)` is replaced by `weekStart(weekend: number[]): number`. `nextWeekStart` and the `nextweek` snooze use it. **Amended 2026-10-03 (as built):** the new function is `weekStartDay(weekend: readonly number[]): number` in `zones.ts`, and `weekStart(z)` stays for the zone's own default weekend; `CalData.weekStart` carries the brand's. Snooze presets do not skip Eid: they are the owner's own times.

### 1.5 Route and page

- **`GET /api/secretary/calendar`**
  - Access: role action `read`, rate `allow(sec:read:{email})`.
  - Returns `{ calendar, effective, upcoming }`:
    - `effective` is the summary of `CalData`;
    - `upcoming` is the next 12 months of quiet days, each with its reason and name, plus the next Ramadan.
  - **Amended 2026-10-03 (rulings R13 and R23, as built):** the answer is `{ ok, calendar, effective, upcoming, eids }`. `calendar` is null when nothing is saved or the stored value is not settings the calendar can be built from (the defaults apply). `effective` is `{ country, zone, weekend, defaultWeekend, weekStart, ramadanHours }`, `defaultWeekend` being the zone's own so the page can mark the country default. `eids` is this and next Hijri year's Eid al-Fitr and Eid al-Adha, each with Umm al-Qura's month start, the one in force, the `hijriFix` value each "a day earlier / later" button saves, the holiday's name and its days off. PUT answers the same for the new settings.
- **`PUT /api/secretary/calendar`**
  - Access: `brand.write` (admin).
  - Validation: field by field; any other field is refused.
  - Write: under `withLock(scope, "cal")`, with rate `allow("sec:cal:{email}")` at 30 per hour.
  - Audit: one `calendar` line in `sec:audit` with the login.
- **Page:** a «أيام العمل» / "Working days" panel on the to-do page. Admins edit it; members read it.
  - **Weekend:** checkboxes, with the country default marked. When the brand's city names Sharjah, a one-line hint suggests adding Friday.
  - **Ramadan hours:** two windows, the second optional.
  - **This year's and next year's Eid dates,** with "starts a day later / earlier" buttons.
  - **Holidays:** this year's list with on/off switches, "add a day for this year only" and "add a yearly day" (Hijri or Gregorian). The defaults are labelled «متوقعة — تأكد من الإعلان الرسمي» / "Expected; check the official announcement".
  - **Preview:** the next quiet days.
- **Agents:** none of this can be changed from chat or MCP. `update_brand` cannot touch it.

## 2. When Reem suggests chasing (A1)

### 2.1 One rule

One pure rule lives in `secretary-agenda.ts`, with its data passed in:

`chaseMoment(it, now, cal: CalData, away: AwayMap): { anchor: number; at: number; why: "normal" | "away" | "quiet" | "ramadan" }`

1. **Base.** `base = chaseAt(it, zone, cal)`:
   - the due date, else `expectBy`, else creation + 2 working days;
   - after a follow-up, the later of that and the last follow-up + 2 working days.

   `chaseAt` passes `cal` to both of its `addWorkingDays` calls. With `CalData`, `addWorkingDays` skips weekend and quiet days, so Eid and holidays never count toward the two working days. `defaultExpectBy` does the same. Items saved before A1 keep their stored `expectBy`.
2. **Agents.** For items owed by an agent (`owedBy` is an agent id), the result is `anchor = at = base`. Agents keep no weekend, Eid or holidays.
3. **Away.** If `away[partyKey(owedBy)]` has `until` on or after base's local day, base becomes the first working moment after `until` (`why: "away"`).
4. **Weekend and quiet days.** If base's local day is a weekend or quiet day, base moves to `briefAt` on the next non-quiet day (`why: "quiet"`, unless it is already "away").
5. **Ramadan.** If base's day is a Ramadan day and base's local time is outside every window, base moves to the next window start that day, or to the first window of the next non-quiet day (`why: "ramadan"`).
6. **Anchor.** Steps 4-5 loop at most 400 times. `anchor = base` after the loop.
7. **Today.** The chase is paused whenever today is not a working moment. When `anchor <= now`, and now's local day is a weekend or quiet day, or a Ramadan day with now outside every window, then `at = firstWorkingMoment(now)` with `why: "quiet"` or `"ramadan"`. Otherwise `at = anchor`.

`firstWorkingMoment(t)` is the earliest moment at or after `t` that falls on a non-quiet day: `briefAt` on that day, or the next Ramadan window start on a Ramadan day.

### 2.2 The agenda

**`AgendaEntry` changes.** `AgendaEntry.next` keeps its string type (`NextStep`) unchanged, and `"wait"` stays a string. A new optional field `moment?: { anchor: number; at: number; why: … }` is set for every item owed by a contact.

**`classify` for items owed by others:**
- `at > now`: the item is in `waiting`, even when its `dueAt` has passed.
- Otherwise the buckets stay as today: `chase`, or `overdue` when `dueAt` has passed.

**Owner items** are unchanged, including on Eid. Their reminders fire as before.

**Showing the reason.** `nextStepText(e, lang)` takes `Pick<AgendaEntry, "next" | "item" | "moment">` and adds the reason line when `moment.why !== "normal"`. The page row and `itemLine` use it, and names are JSON-quoted in `itemLine`. Dates use Latin digits (`dates.ts`, `ar-u-nu-latn`).

| why | Arabic | English |
|---|---|---|
| away | «{name}: غياب لين {date}» | "{name}: away until {date}" |
| quiet | «المتابعة {day} — {reason}» (reason = the day's name: «عطلة نهاية الأسبوع»، «إجازة عيد الفطر»، «يوم التأسيس»، «اليوم الوطني»، «إجازة رسمية»…) | "Follow up {day}, {reason}" |
| ramadan | «تابعه بعد {time} (ساعات رمضان)» | "Follow up after {time} (Ramadan hours)" |

**Where it applies.** Everything that suggests chasing reads the agenda, so the rule applies everywhere:
- the to-do page;
- the walk, which offers chase cards only for `chase` and `overdue`;
- the morning brief's counts and email;
- the evening wrap's "tomorrow", via `buildWrap` with `CalData`;
- `agenda_get` and `agenda_next`.

**Morning brief and Ramadan.** The brief also counts a they-owe item whose `at` falls later the same local day (a Ramadan window) as a chase, shown with its time.

**WhatsApp.** The link stays. Under it the row shows the same reason line.

### 2.3 Alerts

**Input.** `overdueTodoAlerts` passes:
- the `overdue` entries, as today;
- they-owe entries in `chase`, dated or not;
- on a Ramadan day, they-owe entries in `waiting` with `moment.why === "ramadan"` whose `at` falls today.

**Amended 2026-10-03 (rulings R15, R16 and R18, as built):** every `waiting` entry is passed, so the marker of a step that only holds today can be set again (7 days, never a claim) and no step is sent twice across a long Eid; of them only a debt held for Ramadan hours later today is sent, whatever moved its moment there (Ramadan's off-hours, or the brief time after an absence that ended in Ramadan). Items owed by an agent count their steps in calendar days from the anchor and alert any day, like the owner's own.

**Amended 2026-10-03 (ruling R29, as built): Ramadan and the once-a-day run.** In Ramadan a contact's debt that becomes chaseable later the same local day, whatever its `why` (one due at 14:00 inside the window, or one moved to the 10:00 window), is alerted at the morning run (08:00 at UTC+3, 09:00 at UTC+4) with «تابعه اليوم بعد HH:mm» / "Follow up today after HH:mm", and the brief counts it as a chase with that time: the daily run happens once, so holding it until its time would lose step 0. Only contacts: an agent's item keeps no Ramadan hours (ruling R16) and is alerted once it is due, as on any day.

**Known edge case (ruling R31, documented, not fixed).** When every Ramadan window of a brand ends before the morning run (windows set only before 08:00), no contact debt is inside a window at the run and none opens later that day, so contacts' steps hold (`send: false`, their markers kept) for the whole of Ramadan; the brief and the page still list the debts.

**Steps.**
- Owner items count steps from `dueAt`, as today.
- Items owed by others count the alert steps (0, 1, 3, 7) in **working days** from the local day of `moment.anchor`. Quiet days do not count, so no step is lost.
- No alert for an item owed by others is sent on a weekend or quiet day.
- The fingerprint is `overdueAlertFingerprint(scope, id, anchorMs, step)`. Here `anchorMs` is `moment.anchor` for items owed by others and `dueAt` for owner items.
- The fingerprint format is unchanged for owner items. On the deploy day, an item owed by others may get at most one extra alert, because its anchor or its working-day step differs from yesterday's calendar-day step. That follows the new rule and is accepted.

**Texts.**
- Ramadan: «تابعه اليوم بعد {time}» / "Follow up today after {time}".
- Back from away: «انتهى غياب {name} — وقت المتابعة» / "{name} is back: time to follow up". It is sent once per absence, with its own fingerprint `todo-back:{scope}:{id}:{until}` (7-day TTL). It goes on the first alert after an away entry that ended in the last 7 days; later steps use the normal text.

## 3. Contacts who are away (A1)

### 3.1 Data: `sec:away:{scope}`

A hash.
- **Field:** `partyKey(label)`.
- **Value:** JSON `{ label, until: "YYYY-MM-DD" (local, inclusive), note?: string, by: string (login), via: "web", at: ISO }`.

`partyKey(label)` runs `party()`'s cleanup, then:
1. removes every `\p{Default_Ignorable_Code_Point}` (U+00AD, U+200B-U+200F, U+2060-U+2064, U+FE00-U+FE0F, U+3164…);
2. applies NFKC and lowercase;
3. strips tashkeel and tatweel;
4. folds أ إ آ ٱ → ا, ة → ه and ى → ي;
5. collapses spaces;
6. refuses `too_long` past 80 characters.

The same function looks up an item's `owedBy`. «أحمد», «احمد» and «إحمد» are therefore one contact. "Ahmad" and «أحمد» stay two, and the picker shows that.

**Rules**
- **Contacts only.** `not_contact` refuses a label whose `partyKey` equals the `partyKey` of an agent id or of an owner alias ('owner', 'me', 'you', 'أنا'). Latin names equal to agent ids are stored as agents today (pinned by a test) and cannot be marked away. That stays as it is.
- **Dates.** `until` is today or later, and at most today + 366 days (`away_range`).
- **Note.** `note` goes through `cleanLine` and is at most 200 characters after cleaning.
- **Cap.** At most 200 fields in the hash, ended entries included (`away_limit`).
- **Writes.** PUT and DELETE run under `withLock(scope, "away")`, both with rate `sec:write:{email}`.
- **DELETE** ends the entry: it sets `until` to yesterday and keeps it for the "back" alert.
- **Daily clean-up.** `secretaryDaily` removes fields whose `until` is more than 7 days past, in one round (`Promise.all` of `db.hdel`, or a new `Store.hdelMany`). It writes one `away_clean` audit line.
- **Amended 2026-10-03 (rulings R19 and R21, as built):** ended entries are kept 30 days (`AWAY_KEEP_DAYS`), not 7, before the clean-up removes them; the "back" alert window stays 7 days. Otherwise the clean-up on day 8 would put chase moments back where the absence had moved them and send their steps again. Because ended entries count toward the 200 cap for those 30 days, `DELETE` takes `{ label, remove? }`: `{ label }` ends a running absence and is idempotent (an entry that has already ended stays as it is, so a double click on "End now" never loses the back alert), and `{ label, remove: true }` deletes the field (HDEL), ended or not.
- **Audit.** Every write and end appends an `away` or `away_end` line to `sec:audit`, with the login, the label and the date.

### 3.2 Who sets it

- **`GET /api/secretary/away`**
  - Access: `read`, rate `sec:read`.
  - Returns the list, with ended entries (last 7 days) marked. **Amended 2026-10-03 (ruling R20, as built):** it returns every stored entry, ended ones marked `ended: true`, since under ruling R19 they count toward the cap for 30 days and the owner must see them to remove them.
- **`PUT /api/secretary/away`** `{ label, until, note? }`
  - Access: `todo.write`.
  - Creates the entry or replaces it.
- **`DELETE /api/secretary/away`** `{ label }`
  - Access: `todo.write`.
  - Ends the entry now. **Amended 2026-10-03 (ruling R21):** `{ label, remove: true }` deletes it instead (§3.1).
- **Chat: `contact_away { name, until | clear: true }` saves nothing.**
  - It returns a card under Reem's reply, collected the way `update_brand`'s offers card is (`src/lib/brand-proposals.ts` pattern).
  - The card shows the name as typed, the contact it matches, the date, and the number of open items affected.
  - The entry is written only when a login with `todo.write` presses Save. Save goes through `PUT` (or `DELETE` for clear).
  - `toolsFor` offers the tool only when the turn's agent, the `agent` of the `/api/chat` request, is `reem`. MCP's `ask_noor` always runs Noor.
  - `runTool` also refuses `contact_away`, with nothing written, unless `ctx.agent === "reem"` (explicit, no default), `ctx.via !== "mcp"`, and neither `ctx.by?.kind` nor `user.actor?.kind` is `"token"`. This mirrors `propose_handoff`.
- **Page.**
  - A «الغائبون» / "Away" panel on the to-do page, with the list and an "End now" action.
  - An "Away until…" action on rows owed by others, with the name pre-filled.
  - The name field suggests the brand's existing contact labels from the open items already loaded.
- **Reem.**
  - `agenda_get` lines carry the away text from section 2.
  - `content/skills/secretary.md` says she does not suggest chasing an away contact, and that she proposes an absence only from the owner's own words.

## 4. Recurring items (A2)

> Amended 2026-10-03 (A2): sections 4 to 6 below are written as built, with the plan's rulings R32-R54 (`docs/superpowers/plans/2026-10-03-reem-phase3a2-recurring-purge.md`). Where the plan overrides this spec, the text says which ruling. `docs/system/flows.md` section 40 describes the code.

### 4.1 Data

These are optional `SecItem` fields, absent on items saved before A2:

```ts
type SecRepeat = {
  every: "day" | "workday" | "week" | "month" | "year" | "hmonth" | "hyear";
  interval: number;      // 1-99; "workday" always 1; "hyear" at most 10
  anchor: string;        // local "YYYY-MM-DD" of the first occurrence; set when the rule is set or changed, never by a reschedule
  weekStart: number;     // the brand's effective week start when the rule was set ("week" periods count from it)
  time?: string;         // local "HH:mm" of every copy; absent = all-day (R36). Set when the rule is set or changed, from the item's dueAt; a reschedule never changes it
  weekdays?: number[];   // "week": 0-6, unique values, 0 = Sunday; default the anchor's weekday
  monthDay?: number;     // "month": 1-31 or -1 (last day); "hmonth": 1-30 or -1; default the anchor's day
  remindBefore?: number; // minutes before dueAt, 0-10080; set from the reminder on a recurring item
  until?: string;        // "YYYY-MM-DD", inclusive
  count?: number;        // 1-999 occurrences in all
};
repeat?: SecRepeat | null;
series?: { id: string; n: number };   // id "r" + 16 hex; n = 1 for the first occurrence
nextId?: string;                      // on a closed copy: the copy opened after it
closedBy?: { actor: SecActor; login?: string }; // set by every close path; cleared on reopen; not copied
```

**Dates**
- A recurring item always has a `dueAt`. Setting `repeat` on an undated item sets `dueAt` to the rule's first occurrence from today, all-day.
- `repeat_needs_due` (400, field `dueAt`) is one check in `mutateItem` after the update and reschedule branches build the next state: `next.repeat && !next.dueAt`. It covers update, reschedule to null and `clear_due` from every caller (R38).
- `year` and `hyear` use the anchor's month and day.
- The rule carries the time of day (`time`, R36): a copy is built from the rule's time, so the page's reschedule form, which turns an all-day item into a timed 23:59 one, does not make the next copy inherit that. An edit of the time of day through the `update` path (not `reschedule`) also sets `rule.time`, so the next copy keeps it (R53); `reschedule` stays a one-off.
- The first time a rule is set on an item with no `series`, `series = { id: newSeriesId(), n: 1 }` is minted (R42). It is kept after `stop_repeat`, so the history stays exportable.
- `SKIP_RESULT` is the constant `"skipped"`, stored in `result` by a skip. Every display site translates it (`resultText(result, lang)`: «تخطيت هالمرة» / "Skipped this time"): the page, notes, tool answers, the evening wrap and the CSV. The new `SecNote` kind `two_open` is worded by `noteText`.

**Reminders**
- Setting a reminder on a recurring open item sets `remindBefore = dueAt − remindAt` only when that is 0 to 10080 minutes (R37); otherwise the reminder applies to this copy only and `remindBefore` is deleted. This applies from the page, from `remind_at` and from the rule form.
- Clearing it on purpose deletes `remindBefore`.
- `fireReminder` never touches `repeat`.

### 4.2 The next date

`nextOccurrence(rule, prevDue, now, z, cal, n)` (`n`: the copies made so far, the closed one included):

1. **Candidates** come from the anchor's grid. Candidate k is anchor + k·interval units (k ≥ 0), always computed from the anchor:
   - the day is clamped per candidate (the 31st → the month's last day; 29 Feb → 28 Feb; Hijri 30 → 29) and never fed back;
   - a copy is built from the rule's `time` (R36): a timed rule gives a timed copy, an absent `time` an all-day one;
   - for `week`, the periods are 7-day blocks counted from the start of the anchor's week (`rule.weekStart`), and blocks k·interval carry the chosen weekdays;
   - `workday` takes every non-quiet day from `CalData`.
2. **The result** is the first candidate O with O > prevDue, and:
   - for timed items, O > now;
   - for all-day items, O ≥ the start of today (local).

   So missed dates never pile up, and a timed copy never opens already overdue.
3. **Rescheduling one copy** moves only that copy. The grid stays on the anchor.
4. **Gregorian helpers** are pure, in `secretary-agenda.ts`, including the new `addMonthsClamped`.
5. **Hijri** (`hmonth`, `hyear`) lives in `secretary-calendar.ts`. The anchor's Hijri month and day are read by pure Umm al-Qura (no `hijriFix` applied to the anchor), and the candidates are placed on the effective calendar, with the brand's `hijriFix`. The search is bounded at 366 × interval days (at most 16 Hijri candidates).
6. **The series ends** when `series.n >= count` or the next date is after `until`. The last copy closes normally and opens nothing.
7. **Spawned copies skip the date-range check** (R40): a copy of a yearly series with an interval above 5 can be further than `WHEN_RANGE` (now + 5 years). Rescheduling such a copy from the page keeps the range check. `parseRepeat` keeps this spec's bounds.

### 4.3 Opening the next copy

A copy closes through:
- `complete` or `confirm_done` (in `changeItem`);
- the new `skip` action;
- `closeLinked`.

In every case the spawn runs under the closed copy's item lock (`withLock`, unchanged: R47 does not take the `lockOwned` path; its 10 s TTL covers the two writes and one nested delete). `changeItem` reads the calendar for every close action, and `closeLinked(scope, id, who, at: { zone, cal })` takes it from the agenda's own read (R39). A copy spawned while an agenda is being read shows on the next read; the claim and the open-state check make repeated reads idempotent. Copies carry no links, so only a series' first copy can auto-close.

1. **Skip the spawn** when any of these hold:
   - the copy has no `repeat`;
   - the series has ended;
   - `nextId` names an existing copy that is not deleted.

   When `nextId` names a missing record, spawn again.
2. **Claim** `sec:spawn:{scope}:{closedId}` with `setNx` for 2 days, value = `newSecId()`:
   - if the claim exists and names a live record, that record is kept unchanged;
   - if it names a missing record, the claimed id is used and the record is written;
   - if it names a soft-deleted record, the claim is stale: mint a new id and overwrite the claim;
   - an existing live record is never overwritten. The new copy is written with `get`, then `set` only if absent, under the closed copy's lock: only a spawn of the same closed id knows the claimed id, and it holds that lock (R33).
3. **Build** the next copy with rev 1, the closed copy's source, and `series.n + 1`:

   | Fields | Treatment |
   |---|---|
   | title, description, kind, direction, owedBy, owedTo, phone, priority, critical, repeat | Copied |
   | dueAt, allDay | From `nextOccurrence` |
   | remindAt | `dueAt − remindBefore` when that is in the future, else none (R41: without `remindBefore`, null) |
   | notes, result, links, proposedDone, snoozeUntil, lastChasedAt, handoffFrom, closedBy | Not copied. Copying links would make `closeLinked` close the copy again on every read and spawn again |
   | expectBy | null (R41) |
   | createdAt, updatedAt | now (R41) |
   | completedAt, deletedAt, expiresAt, nextId | null / absent (R41) |
   | source | the closed copy's (R41) |
4. **Write in two rounds, the closed copy first** (R51, replacing the earlier order).
   - **Round 1:** the closed copy with `nextId` (the claimed id) and `closedBy`, `indexWrites(scope, prev, closed, { kept })` and the close's audit line.
   - **Round 2:** the new copy, if no record exists at its id, `indexWrites(scope, null, next)` and the `spawn` audit line by actor `rule`.

   A `nextId` that names a missing record already means "spawn again", so a crash between the rounds leaves a done copy and nothing visible; the owner's retried close (`complete`, `confirm_done` or `skip` on a done copy that has a repeat, whose `nextId` names a missing or soft-deleted record) completes the spawn at the claimed id and answers 200 with the closed copy, whatever `rev` it was sent with. There is no daily repair sweep: a failed round 2 that nobody retries stops that series until the owner closes the old copy again (accepted risk). A reused claimed id whose record exists is passed as `prev` to `indexWrites`, so its index moves are cleaned. Every `indexWrites` caller passes `kept` (R50).

**Limits**
- A close plus a spawn leaves the open count unchanged. The spawn checks neither `SEC_OPEN_MAX` nor the per-email create allowance.
- `reopen` and `restore` still check the cap.

**Reopen** of a copy that has a `nextId`:
- The next copy is deleted by a private `deleteNextCopy(scope, nextId, now)`, not through `changeItem`, which refuses `delete` to anyone but the web owner and audits the caller's action (R32; `OWNER_ONLY` and `isOwner` are not widened). It takes the next copy's own lock, re-reads it and soft-deletes it (the usual 30-day restore) with audit `series_reopen` by actor `rule`, only when it is untouched: open, with `rev === 1 + (the number of `reminded` notes)` and no other note (R35: a reminder that already fired does not make a copy "edited"). It answers `"deleted" | "kept" | "gone" | "failed"`.
- The reopen clears `nextId` and DELs `sec:spawn:{scope}:{id}` only when the answer is `"deleted"` or `"gone"` (the next copy is deleted, missing or soft-deleted). When the next copy is kept (edited and open, or already done), `nextId` and the claim stay, so closing the reopened copy again opens nothing; clearing them always, as this spec first said, would spawn a third copy (R34).
- A lock timeout or a failed read is `"failed"`: the reopen answers 503 `lock_timeout` before anything is written (R48).
- If the next copy was edited, both copies stay open (founder decision). The reopened copy gets the `two_open` note whenever any other copy of the series is open after the reopen, found by the `nextId` chain or the series set (R49). For example A → B (done) → C (open): reopening A leaves A and C open and says so. The wording: «النسخة التالية مفتوحة ومعدّلة — صار عندك نسختان» (nominative, «نسختان»; an earlier draft had «نسختين») / "The next copy is open and was edited; there are now two".
- The open-cap check is skipped on a reopen that deletes an open next copy: the net change is zero (R52).

### 4.4 Who does what

| Action | Body | Who | Effect |
|---|---|---|---|
| set or edit `repeat` | page form, `PATCH {repeat, rev}` with the whole rule | `todo.write` | sets or edits the rule on an open item (R53: an update that changes the time of day also moves the rule's time) |
| `stop_repeat` | `{ action: "stop_repeat" }` | `todo.write` on the page (`mutateItem` refuses any actor but the owner in the app: `owner_only`) | `repeat = null`; the item stays a normal open item and keeps its `series` |
| `skip` | `{ action: "skip" }` | `todo.close` (admin) | closes with the constant result `skipped` (shown as «تخطيت هالمرة» / "Skipped this time" through `resultText`), needs a repeat (`bad_action` otherwise), and opens the next |
| `delete` | as today | `todo.close` | deletes this copy and opens nothing; the series ends |
| keep history | `PUT /api/secretary/series/{seriesId}/keep` `{ keep }` | `keep: true` → `todo.write`; `keep: false` → `todo.close` | see section 5 |

**Reem and MCP.** `todo_create` and `todo_update` gain `repeat` (same schema and validation, `repeat_invalid`) and `stop_repeat`.

- **Who may set it.** `runSecretaryTool`'s ctx gains `agent?: AgentId`; `runTool` passes `agent: ctx.agent` and keeps its `?? "reem"` default only for the actor (R46). The gate reads `repeat` and `stop_repeat` only when the call comes over MCP (`who.via === "mcp"`) or from chat with the turn's agent explicitly `reem`, and runs before `allow()`, so a refused call spends no `sec:write`.
- **Strict-safe schema** (R45). `repeat` is a nested object with `additionalProperties: false`, `required: ["every"]`, `every` an enum, plain integers and strings, no `minimum`, `maximum` or `minLength`. Every range check is in `parseRepeat`.
- **Other agents.** For any other agent the call answers «لم يتم: التكرار يضبطه المالك أو ريم» / "Not done: only the owner or Reem sets a repeat", and nothing in that call is saved. Every agent still sees `todo_create` and `todo_update`.
- **Ending a series from chat or MCP** is refused with `owner_only` (403, field `repeat`). This covers `stop_repeat`, `repeat: null`, an `until` before the next date, and a `count` ≤ `series.n`.
- **`skip`** is owner-only, like `complete`.
- **Handoff notes** (`secretary-handoff.ts`) never carry `repeat`.

**Showing it**
- `repeatText(rule, lang)` writes the badge, for example «يتكرر كل يوم أحد» / "Repeats every Sunday" or «شهرياً بالهجري يوم 15» / "Monthly (Hijri) on the 15th". It uses Latin digits.
- `itemLine` adds `repeats: …`.

## 5. Deleting closed copies after 90 days, with a warning (A2)

### 5.1 Indexes

| Key | Type | Holds |
|---|---|---|
| `sec:series:{scope}:{seriesId}` | sorted set, score = completedAt | every closed copy of the series, kept or not |
| `sec:serieslist:{scope}` | set | series ids, so `secretaryKeys` can list the per-series keys |
| `sec:sdone:{scope}` | sorted set, score = completedAt | closed copies not yet warned, of series not kept |
| `sec:spurge:{scope}` | sorted set, score = purge time | warned copies |
| `sec:serieskeep:{scope}` | set | kept series ids, at most 500 (`keep_limit`) |
| `sec:swarn:{scope}:{seriesId}` | string, TTL 30 days | the marker that a series was named in a warning (R44); value = when, written with SET after the notification went out |

**`indexWrites(scope, prev, next, opts?: { kept?: boolean })`** ZADDs the id to `sec:series:…` (and the series to `sec:serieslist`) on every transition into done, from open or from deleted (`to === "done" && from !== "done" && next.series`). It ZADDs to `sec:sdone` unless `kept`. It does not read the keep flag (R43): `changeItem` and `closeLinked` read `SISMEMBER sec:serieskeep` under the item's lock, only when a copy of a series enters done, and pass the answer; `spawnNext`, the plain close path of the last copy of an ended or stopped series, `restore` and `reopen` all pass it (R50). Reopen, delete and purge remove the id from `sec:series:…`, `sec:sdone` and `sec:spurge`.

### 5.2 Warn, then delete

Both steps run every day inside `secretaryDaily`. They do not depend on the follow-ups switch, the brand file or the week start.

**Warn**
1. `zrangeByScore(sec:sdone, now − 83 d, 200)` takes copies whose 90-day mark is within 7 days.
2. One notification per brand lists their series and the earliest date:
   - Text: «فيه {count} من «{title}» بتنحذف ابتداءً من {date}. تقدر تحتفظ بالسجل أو تنزّله CSV» / "{count} closed copies of "{title}" will be deleted from {date}. Keep the history or download it as CSV".
   - `{count}` uses `arCount` (نسخة واحدة / نسختين / N نسخ / N نسخة).
   - At most 5 series per notification, then "and {k} more".
3. Delivery: kind `todo`, href `/{lang}/app/todo?series={id}`, fingerprint `brandFingerprint(scope, "todo-purge:{localDay}")`, 7-day TTL. The email follows unless the owner's email preference is none.
4. **Ids move only after a push that returned a notification (R44, founder 2026-10-03).** A same-day rerun (the fingerprint was claimed) moves nothing, and a throw moves nothing. Only the ids of the at most 5 series the text names move, from `sec:sdone` to `sec:spurge` with score `max(completedAt + 90 d, now + 7 d)`; the rest wait for the next day.
5. **A series is named once.** Then a marker `sec:swarn:{scope}:{seriesId}` (SET, 30 days) silences it, so a daily series does not produce a bell entry and an email every day. Copies of a warned series that reach the window later move silently to `max(completedAt + 90 d, warnedAt + 7 d, now + 7 d)`, always later than the copy that was named, so the invariant holds per series: a copy is deleted at least 7 days after a warning that named its series. When the marker lapses the series is named again (about monthly for a daily series).
6. **Warn cleans what it skips (R50).** Kept ids and ghost ids (no record, not closed, no series) leave `sec:sdone` as they are met, so they never fill the 200-row window. The daily step also re-adds, for unkept series, closed copies missing from both `sec:sdone` and `sec:spurge` (`requeueSeries`), which makes an un-keep that died half-way resumable.

**Delete**
1. `zrangeByScore(sec:spurge, now, 200)` takes the warned copies that are due.
2. Each copy is deleted under its own item lock (`pmap`, concurrency 8). The item is read again with its `sec:spurge` score and `SISMEMBER sec:serieskeep`, and deleted only when it is still in `sec:spurge` with a score due now, still done, its series is not kept, and it was closed at least 90 days ago. A copy that is no longer eligible only leaves `sec:spurge` (closed again, it goes back to `sec:sdone` to be warned again). One copy's failure is logged and skipped; the others are still deleted, counted and audited.
3. Each delete removes the id from `sec:item`, `sec:all`, `sec:done`, `sec:open`, `sec:due`, `sec:spurge` and the series set.
4. One audit line records the count.

So a copy is always deleted at least 7 days after a warning that named it. A failed run delays the deletion; it never skips the warning.

**Keep and un-keep**
- Keeping a series writes `sec:serieskeep` first, then ZREMs that series' ids from `sec:sdone` and `sec:spurge`.
- Un-keeping ZREMs the copies from `sec:spurge` (a stale entry from a warn run that raced the keep) and ZADDs them back into `sec:sdone` only, and deletes the series' marker, so they are named in a new warning at least 7 days before any deletion. The switch says so.
- A keep that races a close is guarded twice: the warn step reads `SMEMBERS sec:serieskeep` once and skips kept ids, and the purge re-checks under the lock.

**Idle brands** (archived, or the account suspended) run no warning and no deletion until the brand is active again.

### 5.3 Routes

**`PUT /api/secretary/series/{seriesId}/keep` `{ keep: boolean }`**
- `seriesId` must match `^r[a-f0-9]{16}$` and name a series with at least one item under `sc(u)` (one ZCARD of its series set). Otherwise the answer is 404 and nothing is written.
- `keep: true` needs `todo.write`. `keep: false` needs `todo.close`, because it makes copies deletable.
- Rate `sec:write:{email}`.
- Audit `series_keep` or `series_unkeep`, with the login.

**`GET /api/secretary/series/{seriesId}/export`**
- Access: `read`, rate `sec:read`, same id checks (404).
- Reads `sec:series:{scope}:{seriesId}` newest first. `pmap` MGETs chunks of 500, up to 5,000 rows, then a "truncated" row.
- Columns: title, due, closed at, result, closed by.
- Format: UTF-8 with a BOM. Each cell is written as the activity export's cell: `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`. Content-Disposition `series-{seriesId}.csv`, never the title.
- Copies closed before A2 export an empty "closed by".

**The `?series=` view** on the to-do page reads the same set (up to 200 rows) and shows the "Keep history" switch and "Download CSV".

## 6. Permissions summary

| What | Who | Held in |
|---|---|---|
| Read calendar, away list, series CSV | any member (`read`), rate `sec:read` | routes |
| Change working days (weekend, Ramadan hours, Eid and holiday corrections) | admin (`brand.write`) | `PUT /api/secretary/calendar` |
| Mark a contact away / end it | `todo.write` on the page; from Reem's chat a card saved by a person | route; `contact_away` offered to Reem and refused in `runTool` otherwise |
| Create or edit a recurrence | `todo.write` on the page; Reem's chat and MCP (any other agent, and a chat call with no agent, is refused before `sec:write` is spent) | `runSecretaryTool` agent/via check, `parseRepeat` |
| Stop or end a series | `todo.write` on the page; refused from chat and MCP (`owner_only`) | `runSecretaryTool`, route |
| Skip a copy, delete it | `todo.close` (admin) | `OWNER_ONLY` and the route role |
| Keep a series' history / stop keeping | `todo.write` / `todo.close` | route |
| Other agents | see `todo_create`/`todo_update` but cannot set `repeat`; never see `contact_away` | `runSecretaryTool`, `toolsFor`, `runTool` |
| Connector data, pasted text | can lead Reem to propose an absence, which a person must save | card + Save |

## 7. Account deletion and keys

`secretaryKeys` adds:
- `sec:cal:{scope}`, `sec:away:{scope}`;
- (amended 2026-10-03, as built in A1) every `secawayprop:{scope}:{id}` and `secawayprop-done:{scope}:{id}` named in `secawayprops:{scope}`, and that index: Reem's away proposals and their outcomes;
- `sec:sdone:{scope}`, `sec:spurge:{scope}`, `sec:serieskeep:{scope}`, `sec:serieslist:{scope}`;
- every `sec:series:{scope}:{id}` named in `sec:serieslist`;
- `sec:spawn:{scope}:{id}` for every id in `sec:all`.

The purge-warning and "back" fingerprints are per-login `notifseen:` keys with TTLs of at most 7 days, as for existing alerts.

Rules 201 and 306 pin that account deletion removes every listed `sec:*` key. The new A1 and A2 rows extend those tests, and `architecture.md` gets the matching key rows.

## 8. Tests (rules)

All dates below are rechecked against ICU Umm al-Qura when the tests are written.

### A1 (470-489)

**Weekend and calendar**
- Effective weekend: the default per zone. A brand override changes `addWorkingDays`, `nowLine`, `nextweek` and the alert's working-day count. A non-contiguous or 4-day weekend is refused. With a Friday-only weekend, the week starts on Saturday.

**Hijri dates**
- `hijriDate(2027-03-09, Riyadh)` is 1 Shawwal 1448 under both `TZ=UTC` and `TZ=Asia/Riyadh`. `hijriFix` moves the date ±1 day only, for the current or the next Hijri year only.

**Eid per country**
- 2027-05-19 (13 Dhu al-Hijjah 1448, a Wednesday) is not quiet in any country.
- 2027-03-08 (29 Ramadan 1448) is quiet in OM only.
- 2026-03-19 (30 Ramadan 1447, a Thursday) is quiet in SA, AE and OM, and not in KW, BH or QA.

**Other holidays**
- QA: the 2nd Tuesday of February is quiet.
- KW: H 03-12 is quiet.
- AE: a Saturday holiday adds no day.
- SA: 2028-09-23 (Saturday) makes Sunday 2028-09-24 quiet.
- BH: 2023-12-16 (Saturday) makes Monday 2023-12-18 quiet.
- OM: 2026 has 25-26 Nov quiet and 20 Nov not quiet.
- A "YYYY-MM-DD" add does not carry into the next year. "H-MM-DD" works every year.

**Ramadan hours**
- The default is 10:00-15:00. `[]` means no restriction. Two windows work, and invalid windows are refused.

**`chaseMoment`**
- In Riyadh, a chase on Friday or Saturday moves to Sunday 08:00, and a Thursday chase is not moved.
- In Dubai, a chase on Saturday or Sunday moves to Monday 09:00, and a Friday chase is not moved.
- A contact away until Thursday in Riyadh is chased Sunday 08:00.
- Eid pushes a chase past the last Eid day.
- A follow-up recorded the day before Eid gives a chase moment on the 2nd working day after Eid.
- An item already in chase the day before Eid is `waiting` on every Eid day.
- In Ramadan, an item is `waiting` at 21:00 and `chase` at 11:00.
- Agent-owed items are never moved.

**Agenda**
- `next` stays a string. A waiting away item's `nextStepText` carries the away line.
- Owner items due on Eid stay overdue with their alerts, and their `remindAt` fires on Eid.

**Away**
- An away contact's items show `waiting`.
- `partyKey` folds alef, taa marbuta and yaa, and drops U+00AD.
- Fullwidth ＤＡＮＡ, the owner and agent ids are refused.
- More than 366 days is refused.
- The 201st field is refused, even when earlier entries ended.
- Two concurrent PUTs at 199 store at most one more.
- DELETE is rate-limited and keeps the entry for 7 days. (Amended 2026-10-03: ended entries are kept 30 days, a second DELETE changes nothing and `remove: true` deletes; rulings R19 and R21.)
- The daily clean-up removes old fields in one round.

**`contact_away`**
- It writes nothing until Save.
- `runTool` refuses it for Noor, over MCP and for a token actor.
- It is absent from other agents' tools and from MCP.

**Alerts**
- An undated they-owe item alerts from its anchor.
- Steps count working days, and nothing is sent on a weekend or quiet day.
- A Ramadan item chase-due at 10:00 is alerted at the 08:00 run with "today after 10:00".
- "Is back" appears once over steps 0-3.
- Ending an absence early produces the back alert.
- Owner items keep today's fingerprints and steps.

**Wrap and routes**
- The evening wrap's "tomorrow" respects the calendar and away.
- `PUT /api/secretary/calendar` is refused to members.
- Away writes with another brand's label never touch another scope.
- `agendaFor`'s store calls are equal for 3 and 40 items (rule 198).
- Account deletion lists `sec:cal` and `sec:away`.

### A2 (490-509)

**`nextOccurrence`, two consecutive steps each**
- 31 Jan → 28 Feb → 31 Mar.
- 29 Feb 2028 → 28 Feb 2029 → … → 29 Feb 2032.
- Hijri 30 → 29 → 30.
- Every 2 weeks on Sun+Tue keeps its grid after a close 3 weeks late.
- `workday` across Eid.
- `until` and `count` end the series.
- A timed copy whose time passed today opens on the next date. An all-day copy opens today.
- A rescheduled copy leaves the cadence unchanged.

**No pile-up**
- Closing a weekly copy 3 weeks late opens one copy, at the next date.

**Exactly once**
- Two concurrent `complete` calls open one next copy.
- A failure after round 1 followed by a retry gives one next copy, and nothing is overwritten.
- Reopen then re-close within 2 days opens a new id, and `sec:deleted` holds no open item.
- A re-close while the next copy is alive opens nothing.
- `nextId` naming a missing record spawns again.

**Reopen**
- An untouched next copy is deleted.
- An edited next copy is kept (two open), with the note.

**Copying**
- links, notes, result, proposedDone and closedBy are not copied.
- Reminder fires, then complete: the next copy has a reminder at `remindBefore`.
- `clear_remind`, then complete: the next copy has none.
- Clearing `dueAt` on a recurring item is refused (`repeat_needs_due`) from update, reschedule and `clear_due`.

**Permissions**
- Noor's `todo_create` with `repeat` is refused and saves nothing.
- Reem and MCP can set `repeat`.
- `stop_repeat` from MCP is `owner_only`.
- A handoff note cannot carry `repeat`.
- `skip` needs `todo.close`, and `delete` ends the series.

**Purge**
- 250 kept copies older than 90 days plus 1 unkept copy: the unkept one is warned, then deleted 7 or more days later.
- No copy is ever deleted without a warning at least 7 days earlier, including after un-keep and after a missed run.
- A reopen between the purge's read and its delete survives.
- A restored deleted closed copy is indexed again.
- Normal items are never purged.
- Idle brands are not purged.

**Keep route**
- A member's `keep: false` gets 403.
- A bad or unknown id gets 404 and writes nothing.

**CSV**
- A result with a comma, a quote, a new line and a leading `=` is exported safely.
- Only that series' set is read.
- A series id from another brand gives 404.

**Account deletion**
- It lists the new keys.

## 9. Docs touched

- `docs/system/architecture.md`: the `secretary-calendar.ts` module and the key rows.
- `docs/system/flows.md`: §39 (A1, including Oman's yearly list as a January maintenance step) and §40 (A2).
- `docs/system/permissions.md`: the new routes and the Reem items list.
- `docs/system/tests.md`: the rules, plus the reserved row.
- `docs/system/variables.md`: unchanged, but it records that no variable was added.
- `content/skills/secretary.md`:
  - the "Gulf adaptations" lines, and the alert sentence pinned by rule 206, updated together with its test;
  - recurring items;
  - away cards.
- `src/lib/help.ts`.
- MCP: `McpPanel.tsx` and the MCP page (`repeat` on `todo_create` and `todo_update`).
- The changelog entry: no promised results and no invented numbers.

## 10. Out of scope

- Calendars (part B).
- Voice notes (roadmap). WhatsApp templates (wishlist). Telegram (deferred since phase 2).
- A contacts address book with one phone per contact. The phone stays per item.
- Quiet days for the owner's own to-dos, the morning brief or reminders.
- Per-emirate or per-region weekends. Brands override the weekend instead; there is a Sharjah hint.
- Noor's weekly plan and agent routines following the brand's week. Today they use the UTC Sunday.

## 11. After merge (each PR)

On production:
- unauthenticated `GET /api/secretary/calendar` and `PUT /api/secretary/away` answer 401 (the old build gives 404);
- the to-do page shows the Working days panel (A1), or the repeat control (A2).

Nothing for the founder to configure. One recurring maintenance step: update Oman's announced holiday list each January (§39).
