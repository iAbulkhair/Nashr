# Phone push alerts (web push)

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 4 of 8. Rule numbers are assigned when it is built. This is "phase 2" that rule 683 and `docs/superpowers/specs/2026-10-08-pwa-install-design.md` left for later.

## ملخص

اليوم التنبيهات في الجرس داخل التطبيق وفي البريد. المقترح إشعارات على الجوال عبر معيار Web Push للتطبيق المثبّت: يفعّلها المالك من الإعدادات > الإشعارات، فيطلب المتصفح الإذن، ونحفظ اشتراك الجهاز، ثم نرسل أنواع التنبيهات التي اختارها فقط (موافقات تنتظر، تذكيرات ريم، تنبيه الرصيد). على آيفون تعمل فقط بعد «أضف إلى الشاشة الرئيسية» (iOS 16.4 فأحدث). هذا أول Service Worker في المستودع، ويقتصر على استقبال الإشعار والنقر، بلا تخزين مؤقت، فتبقى روح القاعدة 683 (لا يُحفظ شيء من الصفحات على الجهاز) ويُعدَّل اختبارها عمداً. الخطر الأهم أن عنوان الاشتراك رابط يرسله المتصفح ويطلب منه خادمنا POST، فيُقبل فقط إن كان لخدمة دفع معروفة ويمر عبر `safeFetch`. يحتاج مفتاحي VAPID يولّدهما المؤسس أو نولّدهما ويضعهما في hPanel.

## Goal

Let a signed-in owner or member get a short alert on a phone or desktop when something waits for them, without opening the app, for the same events and under the same preferences as the bell.

## Today (checked 2026-10-13)

- Bell entries are one capped array per account (`notifs:{email}`, `src/lib/notifications.ts`), kinds `due | pending | weekly | credits | trial | quality | info | todo`. Preferences per type and channel live in `profile:{scope}` as `notify` (`src/lib/notify-prefs.ts`, rules 1144-1148, expand step already taken).
- Email goes through `sendEmail`; WhatsApp is not built (the code comment mentions the Business API).
- PWA: manifest, apple-web-app tags, install hint. No service worker (rule 683, `tests/pwa.test.ts`). The icons are a placeholder letter mark.
- Reem has quiet days and away days (`secretary-away.ts`); push must respect them.

## User flow

1. Settings > Notifications: a row "Alerts on this phone" / «تنبيهات على هذا الجهاز» with the per-topic switches (approvals, reminders, credits). On iPhone without the installed app the row says to add Thakeen to the home screen first and links the install steps.
2. Turning it on: the page registers `/sw.js`, asks `Notification.requestPermission()` (only from the click), subscribes with the public VAPID key, and POSTs the subscription. A test notification confirms it.
3. Later: when the bell would add an entry of an enabled topic, the server also sends a push with a generic title and a path (for example «بانتظار موافقتك» -> `/{lang}/app`), never the task text, a customer name or a number.
4. Tapping the notification opens or focuses the app at that path. Turning the switch off, signing out of that device, or a 404/410 from the push service removes the subscription.
5. Each device is listed with a last-used date and a "remove" button.

## Data shape (rule 679)

- New key `push:{email}`: an array, capped at five, of `{ id, endpoint, p256dh, auth, lang, ua?, at, lastOk? }`. The key is built from the session user, never from the request. Endpoint, p256dh and auth are treated as secrets: never logged, never returned after saving (the list shows `id`, device label, dates).
- `StoredNotify` gains an optional `push?: Partial<Record<InAppTopic, boolean>>`. Old code ignores it (expand). No contract step is needed because the field stays optional.
- `wipeAccount` deletes `push:{email}`.

## Routes and auth

- `POST /api/notifications/push/subscribe`: `currentUser()` first, rate limited, body validated: `endpoint` must be `https`, at most 500 characters, and its host must match an allow-list of push services (Google FCM, Mozilla autopush, Apple web push, Windows WNS), else 400. Owner or member of that account.
- `DELETE /api/notifications/push/{id}`: same auth; removes only an entry under the session user's key.
- `POST /api/notifications/push/test`: sends one test to the caller's own devices; rate limited.
- Server send (`src/lib/push.ts`): uses a web-push library (VAPID, payload encryption) and posts only through `safeFetch` (the endpoint is user-supplied), with a timeout; removes the entry on 404 or 410; no `await db.*` in a loop (batch with `pmap`).
- Called from the places that add bell entries and from the cron paths, under the same preference and quiet-day checks.
- Documented in `permissions.md`, `flows.md`, `architecture.md`.

## Environment variables (names only)

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (secret), `VAPID_SUBJECT` (a `mailto:` address; hello@thakeen.com). With any of them unset the settings row is hidden and the send function does nothing.

## Risks

- SSRF through the subscription endpoint: allow-list the hosts, `https` only, `safeFetch`, no redirects followed to other hosts.
- Content leakage on a lock screen: generic titles only, no names, no amounts, no text a model wrote.
- Spam and cost: one push per event kind per account per window, the same dedupe fingerprints as the bell, a daily cap per account, quiet hours and Reem's away days respected.
- The service worker is the first one: scope `/`, no fetch handler, no cache, served with `Cache-Control: no-cache`; a bug in it is hard to roll back from devices, so version it and keep it tiny.
- Rule 683 is deliberately changed: update its test to say "no cache API and no fetch handler" instead of "no worker file".
- iOS only after install; Safari tabs cannot receive push. The page must say so, not fail silently.
- Permission fatigue: never ask on first load; ask only after the person presses the switch.
- Privacy: subscriptions are personal data; add them to the data download and the processor list (the push services are processors).

## Test plan

- Subscribe: refuses `http`, an unknown host, an over-long endpoint, a body without keys, a request without a session; accepts a known host; the sixth device replaces the oldest.
- Isolation: a user cannot delete or list another user's entry; the key never comes from the body.
- Send: respects the topic switch, Reem's away day and the daily cap; removes the entry on 410; never includes task text in the payload; goes through `safeFetch`.
- Static: the worker file has no `caches.open`, no `fetch` listener; the manifest and rule 683's test are updated together.
- Manual (listed, not automatable): Android Chrome, desktop Chrome and iPhone with the installed app each receive the test push and open the right path.

## Rough size

Medium to large: one worker file, one lib, three routes, a settings panel, prefs field, docs, tests, an edit to the PWA rule, and manual device checks. One pull request, after the HTML email spec and the VAPID variables exist.
