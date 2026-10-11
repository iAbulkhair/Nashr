# Coverage: UI/UX phase 4, the founder console, and Control Center phase 1 (rules 1170-1199)

Status on 2026-10-11 on branch `claude/uiux-phase4` (cut from `claude/uiux-phase3` at 01520482). Rules 1170-1171 are the phase 3 security review's follow-ups on "sign out other devices"; the console rules follow.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1170 | `POST /api/account/sessions` counts wrong passwords only (`spent` before the password, `allow` after a failure), so the real owner's correct tries never use up the 10 an hour. It stamps `devicesAfter` (account or member record, optional, expand), a stamp only `resolveSession` reads, never `sessionsAfter`: the calendar feed, booking links, MCP tokens and connected apps stay, and the settings copy says so in Arabic and English | `tests/uiux-phase4-signout.test.ts` (rule 1170), `tests/uiux-phase3.test.ts` (rule 1150), `tests/profile-allowlist.test.ts` (`devicesAfter` never sent) | — |
| 1171 | `rotateSession`: this device's new session is written before the stamp, and the old session record is deleted after it, so a failure at any step leaves the device signed in | `tests/uiux-phase4-signout.test.ts` (rule 1171) | — |
