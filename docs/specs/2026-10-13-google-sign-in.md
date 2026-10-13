# Google sign-in

Status: proposed, not built, and blocked on one founder task (a Google OAuth client). Written 2026-10-13 against `main` at `4c0264b4`. Build order: 3 of 8. Rule numbers are assigned when it is built.

## ملخص

زر «الدخول بحساب Google» في صفحتي الدخول والتسجيل. يحتاج من المؤسس عميل OAuth من Google Cloud (نوع تطبيق ويب) برابط الرجوع `/api/auth/google/callback`، والنطاقات `openid email profile` فقط، وهي غير حساسة فلا ينتظر تحققاً طويلاً. نقترح عميلاً مستقلاً عن عميل الربط بالتقويم (`GOOGLE_CLIENT_ID`) حتى لا يتشارك السر ولا يتعطل أحدهما بتدوير الآخر، بمتغيرين جديدين. القاعدة: لا ندخل حساباً قائماً إلا إذا كان بريد Google موثّقاً ومطابقاً لبريد الحساب، ونربط بمعرّف Google الثابت (`sub`) لا بالبريد. الحساب الجديد عبر Google يمرّ بنفس موافقة الشروط والخصوصية المسجّلة في التسجيل العادي. حقل كلمة المرور يبقى فارغاً، ويستطيع المالك وضع كلمة مرور لاحقاً من «نسيت كلمة المرور».

## Goal

Sign in to or sign up for Thakeen with a Google account, with the same safety as the password route and no account takeover through an unverified or changed email.

## Founder task before any code

Create an OAuth client in Google Cloud (Web application). Authorised redirect URI: `https://thakeen.com/api/auth/google/callback` (and the staging host for testing). Scopes: `openid email profile`. Put the two values in hPanel (never in chat). Consent screen: app name Thakeen, support email hello@thakeen.com, links to the privacy and terms pages. This task goes into `docs/Owner_Tasks_AR.md` when the spec is accepted.

## Today (checked 2026-10-13)

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` serve the connectors (Business Profile, GA4, Search Console, YouTube) and the `gcal` calendar, with their own redirects. They are not sign-in credentials and stay as they are.
- `createUser` takes email, name, phone, password, lang; `passHash` is a required string; signup records consent (rules 1320-1330) and applies partner attribution and the first-month offer.
- `getLogin(email)` resolves an owner or a member; sessions are `createSession(email)`.

## User flow

1. Login or signup page: "Continue with Google" / «تابع بحساب Google». On signup the terms-and-privacy tick must be set before the button works (the consent record is the same as the form's).
2. `GET /api/auth/google/start` sets a short-lived signed state+nonce+PKCE cookie and redirects to Google.
3. Google returns to `/api/auth/google/callback`. The server exchanges the code, verifies the ID token (issuer, audience, expiry, nonce, `email_verified` true), and reads `sub`, `email`, `name`.
4. Existing link: `google:{sub}` found, so that account signs in.
5. No link, but an account with that exact email exists: signs in only if the account's address is already verified (`emailVerifiedAt`) or the Google email is verified, then links `sub`. Otherwise it is refused with "sign in with your password once to link Google".
6. No account: create an owner (language from the page, phone empty and asked for on the next screen), consent recorded, email marked verified, trial started as for any signup.
7. Members sign in the same way (their address resolves through `getLogin`), and the owner-unverified and disabled rules apply as in the password route.

## Data shape (rule 679: optional fields and new keys only)

- `User.signIn?: { google?: { sub: string; linkedAt: string } }`, optional and new. Old code ignores it and keeps it through its saves; a record without it reads as "no Google link".
- `google:{sub}` -> the account email. The key comes from the verified ID token, never from a request field.
- `passHash` stays a string; Google-created accounts store `""`. `POST /api/auth/login` already rejects an empty hash. `forgot` / `reset` set a real one.
- Contract step: none planned (the field stays optional).

## Routes and auth

- `GET /api/auth/google/start`: public, rate limited by IP (`allow`), Turnstile not required (a redirect, no form).
- `GET /api/auth/google/callback`: public, rate limited; validates the state cookie before anything else; all outgoing calls go to fixed Google hosts with a timeout (not user-supplied URLs, so `safeFetch` is not needed, but a timeout is); the JWKS is fetched from Google's published URL and cached.
- `POST /api/profile/google/unlink`: signed in, owner only, refuses if the account has no password (to avoid locking out), session user only.
- Documented in `docs/system/permissions.md` and `flows.md`; privacy text names Google as the sign-in provider (lawyer check with the other privacy items).

## Environment variables (names only)

`GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` (new; the second is a secret). Existing: `APP_ORIGIN`. When either is unset the buttons are hidden and the routes answer 404.

## Risks

- Account takeover: never match on an unverified Google email; never auto-link when the existing account's address is unverified; key on `sub`.
- Open redirect: `next` goes through `safeNext` and is stored server-side with the state, not in the Google URL.
- A person who changes the Google address keeps the same `sub`, so access follows the person; the Thakeen email does not silently change.
- Consent: signup through Google must not skip the consent record or the partner/referral attribution.
- Google's consent screen shows the app's name and policy links: those pages must be live and honest first.
- Third-party scripts: none; this is a redirect flow, no Google script on our pages (keeps the CSP simple).

## Test plan

- Fake token endpoint and a fixed JWKS: valid token signs in; wrong audience, expired, wrong nonce, missing `email_verified`, bad signature are refused.
- Link rules: verified match links; unverified existing account refuses; a second account cannot claim a `sub` already linked.
- New-account path writes the consent record, partner attribution and trial like password signup.
- State cookie missing or altered: refused with no Google call.
- Member and suspended-owner rules match the password route; an empty `passHash` cannot sign in by password.
- Flag off (variables unset): buttons absent, routes 404.

## Rough size

Medium: three routes, one lib (state, ID-token check, linking), two buttons, tests, docs. One pull request after the founder task is done.
