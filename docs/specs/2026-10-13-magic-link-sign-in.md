# Magic-link sign-in

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 2 of 8 (after the HTML email layout). Rule numbers are assigned when it is built.

## ملخص

اليوم الدخول بالبريد وكلمة المرور فقط. المقترح زر «أرسل لي رابط دخول» في صفحة الدخول: نرسل إلى البريد رابطاً صالحاً 15 دقيقة ولمرة واحدة، والرمز في جزء الرابط بعد `#` (كما في إعادة تعيين كلمة المرور) ولا يُستهلك إلا بطلب POST من الصفحة، حتى لا يستهلكه فاحص الروابط في البريد. الجواب واحد دائماً سواء وُجد الحساب أم لا. دخول الرابط يثبت ملكية البريد، فيعدّ تحققاً (`emailVerifiedAt`). لا حقل جديد على المستخدم ولا متغير بيئة جديد. لوحة المؤسس خارج هذا المسار: لها بابها وعاملها الثاني.

## Goal

Let an owner or a team member sign in with a one-time link mailed to their address, without typing a password. Passwords stay. The link is a second way in, not a replacement.

## Today (checked 2026-10-13)

- `POST /api/auth/login` checks email and password against `getLogin(email)` (an owner or a member of one), rate limited per IP and per login, then `createSession(email)`.
- The reset-password mail carries its token in the URL fragment (rule 546), and email click tracking is off for that reason. Email verification uses a 6-digit code, hashed, with attempts capped (`src/lib/verify-email.ts`, rules 757-758).
- `User.emailVerifiedAt` marks a proven address; an owner without it is signed in but sent to the verify page. Members of an unverified owner get no session (rule 767).
- `mailReady()` says whether mail can reach customers at all.

## User flow

1. Login page: below the password form, "Email me a sign-in link" / «أرسل لي رابط دخول». The person types the email (pre-filled if already typed) and submits.
2. The page always answers the same sentence: "If this address has an account, a link is on its way. It works for 15 minutes." The sentence is shown only when `mailReady()`; otherwise the button is hidden.
3. The mail (HTML layout from spec 1, text part with the same link) has one button: `appOrigin()/{lang}/login/magic#t=<token>`.
4. The page reads the fragment, shows a button "Sign in" (a click is required, so a scanner that opens the link does nothing), and POSTs the token. Success sets the session cookie and goes to `next` (checked with `safeNext`) or the app.
5. A used, expired or unknown token shows one message and a "send a new link" button.

## Data shape

New keys only; no field on `user:{email}` changes, so rule 679 needs no expand and contract:
- `magic:{sha256(token)}` holds `{ email, lang, createdAt, ip? }` with a 900 s expiry. The token is 32 random bytes, base64url, never stored in clear and never logged. The key is derived from the token the caller presents, not from an email or scope in the request.
- Single use: consume with an atomic get-and-delete (or SET NX on `magic:used:{hash}`); two parallel consumes yield one session.
- `magic:sent:{email}` for the resend gap, as `verify` does.
- On success for an unverified owner, set `emailVerifiedAt` under `withUserLock` (a clicked link proves the address as the code does). This is a write of an existing optional field.

## Routes and auth

- `POST /api/auth/magic/send` { email, lang }: public, so rate limited with `allow` (per IP, per email, per day), Turnstile when configured (as signup and forgot do). Looks the login up with `getLogin`; skips suspended accounts and members of unverified or suspended owners silently; same response and similar timing in every case.
- `POST /api/auth/magic/consume` { token }: public, rate limited per IP; checks the same account rules as the password route (suspended, member's owner present and not newer, member not disabled), then `createSession(login.email)` and `track(..., "login")`. Proposed default: the link is refused for founder addresses (`ADMIN_EMAILS`), so the console is only ever reached by password, and `secondFactorRefusal` still gates every console write.
- Page `/{lang}/login/magic` (client page reading the fragment).
- Both routes are listed in `docs/system/permissions.md` as public with a rate limit. CSRF applies as for every `/api` POST (rule 690).

## Environment variables

None new. Uses `RESEND_API_KEY`, `MAIL_FROM`, `APP_ORIGIN`, and `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` if set.

## Risks

- Email scanners and previewers open links: the token sits in the fragment (not sent to servers) and only a POST consumes it.
- Enumeration: identical answer and no timing difference between known and unknown addresses; the daily cap is per address, so the cap itself cannot reveal an account.
- Mail interception equals account access. This is already true of password reset, but a link is a standing invitation to try: cap per address per day and show the sign-in in the account's "devices" list.
- Session fixation: always issue a fresh session id on consume.
- Partner and referral attribution cookies are untouched; the link signs in existing accounts only and never creates one.
- A login that needs a password change after a leak: "sign out other devices" (`devicesAfter`) already ends browser sessions issued before it, including link sessions.

## Test plan

- Send: unknown, suspended, member-of-unverified-owner and valid addresses all return the same body; only the valid one writes `magic:*` and calls `sendEmail`.
- Consume: valid token creates exactly one session when called twice in parallel; expired, reused, malformed (not 43 characters) and forged tokens return the same failure; an unverified owner becomes verified; a suspended account gets no session.
- The mail's text part carries the link; the HTML part has the button; the link points at `appOrigin()` and never at the request host.
- Rate limits: the 429 carries `Retry-After` (rule 680).
- A static test that no route reads `req.url` for the link origin (rule 904 pattern).

## Rough size

Small to medium: two routes, one page, one template, one lib file with the token store, tests and docs. One pull request.
