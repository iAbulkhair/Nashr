# Coverage: one bell entry per subject, and the digest email (rules 2350-2359)

Status on 2026-10-19 on branch `claude/inbox-not-now` (cut from main 70d16757, after the Not now commit a49227bd). Pattern 2 of the Fizzy and Orca study (`docs/reports/2026-10-19-PRD-fizzy-orca_AR.md`); flow in `docs/system/flows.md` section 92. Rules 2358-2359 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2350 | A bell entry may carry `about` (`aboutKey`, from our own values); the due, 48-hour, Not now, quality and reconnect notices name their brand, Reem's reminder and overdue alerts name the to-do | `tests/notif-digest.test.ts` ("rules 2350-2351") | — |
| 2351 | `collapse`: a fresh entry replaces every older one about its subject; `count` grows while the older one was unread and starts again after it was read; entries without `about` are untouched; one push with two about the same subject keeps one | `tests/notif-digest.test.ts` ("rules 2350-2351") | — |
| 2352 | The bell and the notifications page show "×N" (99+ past 99) with the number in words for screen readers; nothing for one | `tests/notif-digest.test.ts` ("rule 2352") | an end-to-end check of the bell after two nudges |
| 2353 | The digest choice (off, 4 hours, day, week) is the account's, off until chosen; on writes the record, a fresh window and the tick's set; off deletes all three; the settings page shows the four choices | `tests/notif-digest.test.ts` ("rule 2353") | — |
| 2354 | The tick sends one email per window with the unread entries that arrived in it, never read or older ones; nothing new closes the window without an email; a refused send keeps it open; a claimed send is not made twice; an account without a record leaves the set | `tests/notif-digest.test.ts` ("rule 2354") | a test that runs the tick route itself with a digest due |
| 2355 | `PUT /api/notifications/digest`: 401 signed out, 403 for members, 400 for a bad choice, rate limited, writes the session's own account with its own address | `tests/notif-digest.test.ts` ("rule 2355"), `tests/role-gates.test.ts` | — |
| 2356 | With a digest on, the daily job does not email the follow-ups itself | `tests/notif-digest.test.ts` ("rules 2356-2357") (source shape) | a daily-route test with a digest on that counts emails |
| 2357 | The account wipe deletes the digest records and takes the account out of the tick's set | `tests/notif-digest.test.ts` ("rules 2356-2357") (source shape) | a wipe test that seeds the digest keys |
