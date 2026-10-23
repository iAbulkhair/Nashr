---
name: change-sign-in
description: Use when changing how people sign up or sign in (password, email code, Google, passkey, two-factor, sessions), reset flows or account security settings.
---

# Change sign-in

Thakeen has its own auth, not a library. Every sign-in path ends in one shared tail, `src/lib/login-finish.ts` (rule 1934): suspension check, second factor, session cookie, last-login record. A new way in must call it, not copy it. Read `docs/system/permissions.md` (sessions, roles) and the passkey and Google specs in `docs/specs/2026-10-20-passkeys.md` and `docs/specs/2026-10-13-google-sign-in.md`.

## Where things are

- Routes: `src/app/api/auth/{login,signup,logout,forgot,reset,verify,google,passkey,email-revert}` and `src/app/api/account/{2fa,email,google,passkeys,sessions,export}`.
- Libraries: `src/lib/auth.ts` (`createSession`, `sessionCookie`, `currentUser`), `src/lib/mfa.ts`, `src/lib/totp.ts`, `src/lib/passkeys.ts`, `src/lib/google-signin.ts`, `src/lib/suspension.ts`, `src/lib/cookie-names.ts` (cookies are `thakeen_*`; legacy `nashr_*` is still read).
- Pages: `src/app/[lang]/app/{login,signup,forgot,reset,verify,join}`.

## Steps

1. Write down the threat first: what could an attacker do with a stolen link, a guessed code, a replayed request, a second account with the same email? Public auth routes are the most attacked surface.
2. Every new public route: `handler({ auth: "public", rate: {...}, maxBytes, input })` (add-an-api-route). Rate limits per IP and per address from `src/lib/rate.ts`. Answers must not reveal whether an address has an account (same text and similar timing for known and unknown).
3. Codes and tokens: random, single use, short expiry, stored hashed or under a key with a TTL from `src/lib/keys.ts`. Compare with `sameSecret`. Never put a token in a URL query that gets logged or sent as a referrer; use the fragment or a POST body where the flow allows.
4. Finish through `src/lib/login-finish.ts`. Do not set the session cookie anywhere else.
5. Sessions: list and revoke through `src/app/api/account/sessions`. A password change, reset or two-factor change must revoke other sessions.
6. Mail sent by the flow (verify code, reset link, new sign-in notice) is a template in `src/emails` (add-or-edit-an-email). Links come from `appOrigin()` in `src/lib/origin.ts`.
7. Two accounts and one person: the multi-workspace work means one login can reach several accounts. Test with the opaque account shape and with `TEST_PERSONS=legacy` (write-a-unit-test).
8. Pages: build the form from `Field` and `Button` (add-a-ui-component). Copy in both languages (add-arabic-and-english-copy). Keep sign-up and login working without JavaScript errors in Arabic.
9. Docs: `docs/system/flows.md` auth sections, `permissions.md`, `variables.md` if a new variable (Google client id and secret are examples; names only, values by the founder).
10. If a stored shape changes (user record, session record), two releases apply (change-a-stored-shape). Old sessions must keep working after the expand release.

## Tests to extend

`tests/routes-auth.test.ts`, `tests/auth-rules.test.ts`, `tests/security-auth-fixes.test.ts`, `tests/auth-review-2990.test.ts`, `tests/passkeys-*.test.ts`. Browser journeys live in `e2e/` (write-a-browser-test); signup specs create their own accounts and are limited to 5 sign-ups per IP per hour.

## Checks

`npx vitest run tests/routes-auth.test.ts tests/auth-rules.test.ts tests/security-auth-fixes.test.ts`, then `npm run check` and `npx next build`.

## Traps

- `APP_ENV=test` returns dev codes in responses. It must never be set on staging or live.
- A new provider that does not verify the email address before linking to an existing account (account takeover).
- Logging a code, token, cookie or password, even in an error path.
- Testing real sign-in on thakeen.com with the founder's password. Use a test account on local or staging only, and never type real credentials for the founder.
