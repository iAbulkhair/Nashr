# Email verification (hard gate) — design

Date: 2026-10-08. Status: approved in conversation, written spec awaiting the founder's review.
Follow-up (separate spec, not this one): WhatsApp phone verification, after email.

## 1. Goal

Nobody uses Thakeen until they prove they own the email address of their login. Stops fake and mistyped signups and
makes every email we send go to a proven address.

Founder decisions (2026-10-08):
- Hard gate: an unverified owner reaches no app page, no API route, no MCP tool and spends nothing.
- Existing accounts must verify too (no grandfathering).
- Proof is a 6-digit code sent by email, typed on a verify page.
- A mistyped address can be corrected on the verify page.
- Enforcement lives in the one session resolver (approach A), failing closed.

## 2. Who is gated

| Login | Verified when | Gated |
|---|---|---|
| Owner account (`user:{email}`) | `emailVerifiedAt` is set | yes, until set |
| Team member (`member:{email}`) | always: accepting the invite used the emailed link | no |
| Founder impersonating an owner | n/a | no (support must reach a stuck account) |

`emailVerifiedAt?: string` (ISO) is added to `User`. Absent means unverified, which is every account that exists on
release day. `gatedSignup?: true` is set by `createUser` from release day on; it marks an account created under the gate.

## 3. Enforcement

- `currentUser()` returns `null` for an owner session whose account has no `emailVerifiedAt`, unless the session is an
  impersonation. Every route and page that calls it therefore treats an unverified owner as signed out (401 / login
  redirect), including routes added later.
- `currentUserUnverified()` (new, `src/lib/auth.ts`) resolves the session the same way but also returns an unverified
  owner. Only these may call it: the verify page and `POST /api/auth/verify/send`, `POST /api/auth/verify/check`,
  `POST /api/auth/verify/email`. Logout needs no user. A test lists its callers and fails on any other.
- `userFromBearer` (`src/lib/mcp.ts`) refuses a token whose owner is unverified.
- `src/app/[lang]/app/layout.tsx`: when `currentUser()` is null but `currentUserUnverified()` is an owner, redirect to
  `/{lang}/app/verify` instead of the login page. The verify page is in the layout's public list.
- Login (`POST /api/auth/login`) is unchanged: the password still creates the session; the gate then sends the person
  to the verify page. The login form follows the redirect it already follows.
- Signup sends the first code right after `createSession` and answers `{ ok: true, verify: true }`; the form goes to
  `/{lang}/app/verify`.

## 4. Jobs and public endpoints for unverified owners

Nothing runs on behalf of an unverified owner:
- Crons `daily`, `evening`, `weekly`, `routines`, `secretary`, `stores` skip accounts without `emailVerifiedAt`
  (no lifecycle or brief emails to unproven addresses, no scheduled tasks spending credits).
- `media` keeps finishing jobs already started and paid (no new spend, and a paid result is not thrown away).
- `golden` is the founder's evaluation and is unaffected.
- Public per-owner endpoints (booking pages, calendar feed tokens) answer as for an unknown owner while the owner is
  unverified.

Consequence the founder accepted: an existing customer's automations and booking page pause until they verify.

## 5. The code

- 6 digits from `crypto.randomInt`, valid 15 minutes, stored as a SHA-256 hash under `verify:code:{email}` with
  `{ hash, attempts, sentAt }` and a 15-minute TTL. A new code replaces the old one. Compared with `sameSecret`.
- 5 wrong attempts delete the code; the person requests a new one.
- Send limits: once per 60 s per account (`verify:send:{email}`), 5 per hour per account, 20 per hour per IP
  (`allow` + `retryLater`, rule 680).
- A correct code sets `emailVerifiedAt` under the account lock, deletes the code, and the client goes to
  `/{lang}/app` (onboarding for a new account, as today).
- When `mailReady()` is false the send route answers `{ ok: false, error: "mail_unavailable" }` and the page shows the
  WhatsApp support link instead of promising an email (same honesty as forgot-password).
- Email: Arabic or English by the account's `lang`, plain text and HTML through `sendEmail`; the code is the only
  dynamic content besides the brand name.

## 6. Verify page

`/{lang}/app/verify`, Arabic first, quiet-D styling (rule 519):
- "We sent a 6-digit code to name@example.com", one input (`inputmode="numeric"`, `autocomplete="one-time-code"`).
- Resend with a 60-second countdown; remaining attempts after a wrong code.
- "Wrong email? Change it" only when the account has `gatedSignup` and has never been verified.
- Log out.
- Signed-out visitor → login. Verified owner or a member → `/{lang}/app`.

## 7. Change email

`POST /api/auth/verify/email {email}`, allowed only when the acting owner has `gatedSignup` and no `emailVerifiedAt`.
Such an account can hold no brand data (the gate blocked every route), so the move is small:
- The new address must be valid and free (`getLogin`), checked and moved under `withLoginLock` on both addresses.
- Carried over: name, phone, password hash, lang, plan, credits, trial end, createdAt, `sessionsAfter`, `gatedSignup`.
  Referral code re-registered for the new address; a referral applied at signup and the partner attribution move
  with it. Old `user:{email}`, its login index and its pending code are deleted.
- A new session is issued for the new address and the old one destroyed; a code is sent to the new address.
- Limit: 3 changes per account per day and the send limits of §5.
- Older accounts (no `gatedSignup`) never see the option; their data is keyed by their address (`sc(u)`), and moving it
  is out of scope.

## 8. Testing

New tests, each checked to fail with its fix reverted:
- `currentUser` null for an unverified owner; returns the member and the impersonated owner; `currentUserUnverified`
  has exactly the listed callers.
- `userFromBearer` refuses an unverified owner.
- Layout redirects an unverified owner to verify.
- Code: expiry, 5-attempt kill, replacement on resend, 60 s / hour / IP limits with `Retry-After`, `mail_unavailable`.
- Change email: refused without `gatedSignup` or after verification, refused to a taken address, moves the listed
  fields, deletes the old record, 3-per-day limit.
- Crons skip unverified owners; `media` still finishes paid jobs.
- Booking and feed endpoints refuse an unverified owner.

Docs in the same commit: `docs/system/flows.md` (signup, login, verify), `permissions.md` (gate), `architecture.md`
(new keys `verify:code:*`, `verify:send:*`), `tests.md` rules from 731.

## 9. Release

Branch `claude/email-verification`, PR, merged by the founder; Hostinger rebuilds from `main`. After release every
owner, the founder included, meets the gate on the next request and verifies once by email (Resend is live).

## 10. Out of scope

WhatsApp phone verification (next spec), changing the email of an older account, Google or Apple sign-in.
