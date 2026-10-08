# Install Thakeen to the home screen (PWA, phase 1) — design

Status: built on branch `claude/laughing-elion-9449f8`, draft PR, not merged, not deployed. Asked for on 2026-10-08 after the founder's question about app-store apps; the recommendation was: before launch make the web app installable, store apps (Expo) later, no in-app purchasing. Rules 681-684, `tests/pwa.test.ts`.

## 1. What phase 1 is

A person on thakeen.com can put Thakeen on the home screen and open it in its own window, with the brand name and an icon. Nothing else changes: same pages, same login, same server. No service worker, no offline mode, no push.

| Piece | File | Notes |
|---|---|---|
| Manifest | `src/app/manifest.ts` (served at `/manifest.webmanifest`) | name «ذكين \| Thakeen», short name «ذكين», Arabic site description, `lang` ar, `dir` rtl, `display` standalone, `scope` `/`, `id` and `start_url` `/app`, theme `paper` (the mobile app header), background `ground`, colours read from `assets/design-tokens.json` (no hex in `src/`, rule 513) |
| Start URL | `src/proxy.ts` | `/app` → 307 to `/ar/app` or `/en/app` by the same choice as `/` (cookie `nashr_lang`, Accept-Language, default Arabic). One manifest serves both languages |
| Icons | `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `src/app/apple-icon.png` (180) | PLACEHOLDER, see section 3 |
| iOS tags | `src/app/[lang]/layout.tsx` | `appleWebApp` (capable, title = the brand word of the page language, status bar `default`) plus the legacy `apple-mobile-web-app-capable` |
| Hint | `src/components/app/InstallHint.tsx`, `src/lib/pwa.ts` | signed-in app shell only, see section 2 |

## 2. The install hint

- Where: one strip under the trial banner, in the signed-in branch of `src/app/[lang]/app/layout.tsx`. Never on login, signup or the marketing site.
- iPhone and iPad Safari: there is no install event, so the strip gives the steps: open the Share menu, choose «إضافة إلى الشاشة الرئيسية» / "Add to Home Screen". iPadOS reports itself as a Mac; touch points tell them apart. Chrome, Firefox, Edge on iOS and in-app views (Instagram, Snapchat, TikTok…) get nothing: their steps differ or they cannot install.
- Chrome, Edge, Android: the strip appears only after `beforeinstallprompt`; its Install button opens the browser's own dialog (the event can prompt once).
- Never shown when already running standalone.
- Dismissal: "Not now" or dismissing the browser dialog writes `nashr_install_hint_dismissed` (time in ms) to localStorage; every read and write is in try/catch, so a private window shows the hint again next visit and never breaks.
- Copy (no claims, `INSTALL_COPY`): the steps and what installing does («يظهر ذكين بين تطبيقاتك ويفتح في نافذة خاصة به»). No speed, offline or notification promise; a test refuses those words.

## 3. Logo: what the founder must supply

The repo has no logo file. `src/app/favicon.ico` is still the Create Next App default, and the share card (`src/app/[lang]/opengraph-image.png`) is in the old green and gold palette. The wordmark is live text in Thmanyah Serif Display, whose licence allows the website build only (rule 317), so it is not rendered into icon files.

Phase 1 ships a placeholder: a «ذ» drawn with SVG strokes, lemon on ink, by `scripts/make-pwa-icons.mjs` (no font, same output on every machine). To replace it, the founder supplies:

1. A square app mark (SVG, or PNG at least 1024×1024), legible at 48 px, on an opaque background.
2. A maskable version: the mark inside the central 80% circle, background colour to the edges.
3. Written confirmation that the mark may be used as an app icon (if it is drawn from Thmanyah letters, the font licence needs checking first).
4. Optionally, a new favicon and a prototype-D share card at the same time.

Then the four PNGs are replaced at the same paths and sizes (or the mark goes into the script); the manifest and tests need no change.

## 4. Caching and security

- No service worker: no worker file, no `serviceWorker.register`, no Cache API (rule 683). Every app page is fetched from the server as in a browser tab; logout and session expiry work as before.
- App pages stay request-time (the layout reads `headers()` and the session); no Cache-Control is configured in `next.config.ts` or `vercel.json`.
- The manifest holds no user data and may be cached. The security headers (CSP `frame-ancestors 'none'`, HSTS…) are unchanged.
- No new API route, no new environment variable, no Redis key.

## 5. Checks a test cannot do (on devices, before launch)

1. Android Chrome: the Install button appears in the app, opens the dialog, the icon on the home screen is the placeholder, the app opens at `/ar/app` (or `/en/app` with the English cookie) in its own window.
2. iPhone Safari (iOS 17 and 18, and 26 if available): the strip shows the steps, "Add to Home Screen" uses the title «ذكين» and the 180 icon, the app opens standalone. Expected: the installed app keeps its own cookies apart from Safari, so the first open asks for a login.
3. From the installed app on both: connect a channel (OAuth on another origin) and return; open billing; log out and back in. If returning from another origin breaks inside the installed app, note it and keep that step in the browser for now.
4. Dismiss on each device and reload: the strip stays hidden. Private window: no crash.
5. Hostinger: `/manifest.webmanifest`, `/apple-icon.png` and `/icons/*` are served with the right content types after a `build:hostinger` deploy.

## 6. Phase 2: push notifications (not built)

Needs, in this order: the founder's choice of which events notify (approvals waiting, Reem's reminders, a finished render); VAPID keys as new secrets in `docs/system/variables.md` (never in chat); a service worker that handles `push` and `notificationclick` only and caches nothing signed in; a subscription store per actor under the caller's scope (`sc(u)`), deleted on logout, member removal and `wipeAccount`; a permission ask only after a user action, never on load; sending from server code with a rate limit; iOS delivers push only to an installed app (16.4+). Its own spec, rules and tests.

## 7. Later: store apps

Expo wrappers for the App Store and Google Play stay a later decision. No in-app purchasing: billing stays on the web (Paymob work is on its own branch).
