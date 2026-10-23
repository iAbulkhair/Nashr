---
name: add-a-notification
description: Use when adding a new in-app, email-digest or web-push notification kind, including its topic, preference and bell entry.
---

# Add a notification

Notifications are per login (an email address), written into the bell list, optionally mailed in a digest and pushed to the browser. The pieces are `src/lib/notifications.ts` (kinds, `pushNotifs`, `followUps`), `src/lib/notify-prefs.ts` (topics and per-person choices), `src/lib/notif-digest.ts` (digest settings), `src/lib/push.ts` (web push) and the bell `src/components/app/NotificationCenter.tsx`.

## Steps

1. Add the kind to `NotifKind` in `src/lib/notifications.ts`. Decide the payload (`Notif`): a short key for the text, an optional link into the app, never a secret or a full record.
2. Map it to a topic in `KIND_TOPIC` in `src/lib/notify-prefs.ts` and decide whether the topic belongs to `IN_APP_TOPICS`, `EMAIL_TOPICS` or both. A kind with no topic fails the type check, which is the point: every notification can be switched off.
3. Create the entry only through `pushNotifs(email, entries, known?)`. It sets a fingerprint with `SET NX` so the same event never produces two bell entries, and it takes the bell lock. Never push straight to the list key.
4. Call `pushNotifs` from the place the event happens (a route or a cron). The recipient is the signed-in person or a member found from our own team records, never an address taken from a request body.
5. Text: add the Arabic and English strings for the kind to `appDict` (add-arabic-and-english-copy) and render them in `NotificationCenter.tsx`. The link goes through `appHref`.
6. Email digest: if the topic is in `EMAIL_TOPICS`, the daily mail picks it up through the digest template (add-or-edit-an-email). Do not send one mail per event from a loop; batch with `Promise.all` or `pmap` from `src/lib/parallel.ts`.
7. Web push: only the kinds the person opted into are pushed. Routes are under `src/app/api/push`; follow the existing subscription checks and never log an endpoint URL.
8. Preferences UI: topics show in the notification settings screen; add the label there if a new topic is introduced.
9. Docs: the kind and topic in `docs/system/flows.md` (notifications section) and the route table in `docs/system/architecture.md` if you added a route.
10. Tests: write-a-unit-test. Cover the fingerprint (two identical events give one entry), the preference off switch, and that another account never sees the entry. Existing tests to extend: search `tests/` for `pushNotifs`.

## Checks

`npx vitest run` on the notification tests you touched, then `npm run check`.

## Traps

- Reading preferences with a shape check of your own. Use `readPrefs`: it fills defaults for people saved before the field existed (expand step of a stored-shape change, see change-a-stored-shape).
- Putting a customer's text or a model answer in the bell without escaping. Render it as plain text.
- Sending a notification for an action the same person just did. Show a toast instead.
- Quiet days and recurring digests have their own rules in `docs/system/flows.md`; read them before adding a timed notification.
