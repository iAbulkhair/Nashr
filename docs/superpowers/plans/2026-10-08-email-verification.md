# Email Verification (Hard Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No owner account uses Thakeen until it proves its login email with a 6-digit code; a mistyped signup address can be corrected on the verify page.

**Architecture:** The one session resolver (`resolveSession` in `src/lib/auth.ts`) refuses an unverified owner, so every existing and future route treats them as signed out. A second, narrow resolver (`currentUserUnverified`) serves only the verify page, its three routes and the app layout's redirect. Codes live in `src/lib/verify-email.ts` (hashed, TTL, attempt counter); scheduled jobs and public links skip unverified owners at their single roster/holds functions.

**Tech Stack:** Next.js 16 app router, Upstash Redis via `src/lib/db.ts`, Resend via `sendEmail` in `src/lib/notify.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-email-verification-design.md`

## Global Constraints

- Rules 751-766 in `docs/system/tests.md` (730-749 are social analytics, 750 is the logout fix). Every rule names its test file.
- Code: 6 digits from `crypto.randomInt(0, 1_000_000)`, zero-padded; stored only as a SHA-256 hash; TTL 900 s; compared with `sameSecret`.
- 5 wrong attempts delete the code. Send limits: 1 per 60 s per account, 5 per hour per account, 20 per hour per IP, each refusal through `retryLater` (rule 680) with that bucket's window.
- Change email: only when the acting owner has `gatedSignup` and no `emailVerifiedAt`; 3 per account per day (counter carried across moves).
- Never build a Redis key from request text except the normalized, validated new email in change-email, and only after `validEmail`.
- No `await db.*` inside a loop; `Promise.all` or `pmap`.
- Email is plain text through `sendEmail(to, subject, text)` (the helper is text-only; the spec's HTML part waits for the HTML mail helper).
- Arabic first in all UI copy; quiet-D styling (rule 519): existing `btn`, `Card`-style classes, no new colours.
- The code is never logged and never returned in a response, except under `APP_ENV=test` on a non-production deploy (rule 766), so the e2e suite can verify.
- Run `npm run check` before every commit; `npx next build` before the last one.

## Review Focus

1. A code typed with Arabic-Indic digits or spaces (`١٢٣ ٤٥٦`) must be accepted: normalize to ASCII digits and strip non-digits before comparing. Test in Task 3.
2. An account that existed before release lands on `/verify` with no code pending: the page sends one automatically, once (not on every reload while a code is pending). Test in Task 6.
3. A member of an unverified owner still signs in and works (members count as verified), while the owner's crons are paused. Test in Task 1.
4. Changing the email to an address that is a member login is refused as `exists`, like an owner address. Test in Task 5.
5. A double-submitted correct code (second request after success) answers `{ ok: true }`, not "expired". Test in Task 4.

---

### Task 1: The gate in the session resolver

**Files:**
- Modify: `src/lib/auth.ts` (`User` type, `createUser`, `currentUser`, `resolveSession`)
- Modify: `tests/helpers/session.ts` (`newUser`)
- Modify: test files whose hand-built owner records sign in (found by running the suite)
- Test: `tests/email-verify-gate.test.ts`

**Interfaces:**
- Produces: `User.emailVerifiedAt?: string` (ISO), `User.gatedSignup?: true`, `User.emailMoves?: { day: string; n: number }`; `emailVerified(u: Pick<User, "emailVerifiedAt">): boolean`; `currentUserUnverified(): Promise<User | null>`; `newUser(prefix?: string, opts?: { verified?: boolean })` (verified by default).

- [ ] **Step 1: Write the failing tests** in `tests/email-verify-gate.test.ts`:
  - `unverified owner reads as signed out`: `newUser("g", { verified: false })`, `signIn`, `expect(await currentUser()).toBeNull()`, `expect((await currentUserUnverified())!.email).toBe(u.email)`.
  - `verified owner passes`: `newUser("g")`, `signIn`, `currentUser()` returns the account with `actor.kind === "owner"`.
  - `founder impersonation passes the gate`: unverified owner, `signIn(u.email, { imp: "founder@test.example" })`, `currentUser()` not null, `actor.kind === "founder"`.
  - `member of an unverified owner signs in` (Review Focus 3): unverified owner, `newMember(owner)` from the helper, `signIn(m.email)`, `currentUser()` not null with `actor.kind === "member"`.
  - `createUser marks gatedSignup and no emailVerifiedAt`: `createUser(...)` result has `gatedSignup === true` and `emailVerifiedAt === undefined`.
  - `suspended stays null in both resolvers`: suspended unverified owner, both functions return null.
  - `currentUserUnverified has exactly the allowed callers` (rule 752): read every `.ts`/`.tsx` under `src/` (fs walk), collect files containing `currentUserUnverified(`, expect the sorted list to equal `["src/app/[lang]/app/layout.tsx", "src/app/[lang]/app/verify/page.tsx", "src/app/api/auth/verify/check/route.ts", "src/app/api/auth/verify/email/route.ts", "src/app/api/auth/verify/send/route.ts", "src/lib/auth.ts"]`. (Fails until Tasks 4-6 add the callers; mark it `it.todo` here and switch it to `it` in Task 6.)

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-gate.test.ts`. Expected: FAIL (`currentUserUnverified` is not exported; `newUser` ignores `verified`).

- [ ] **Step 3: Implement.** In `auth.ts`: add the three `User` fields with doc comments; `export const emailVerified = (u) => !!u.emailVerifiedAt`; `createUser` sets `gatedSignup: true`; `resolveSession(s, opts: { unverified?: boolean } = {})` returns null in the owner branch when `!emailVerified(u) && !s.imp && !opts.unverified` (after the suspended and `sessionsAfter` checks); `currentUser` and the new `currentUserUnverified` share one private reader that takes the option. In `tests/helpers/session.ts`, `newUser(prefix, { verified = true } = {})` saves `emailVerifiedAt` when verified (via `withUserLock` or `getUser`+`saveUser`).

- [ ] **Step 4: Run** `npx vitest run`. Expected: the new file passes; other files that build owner records by hand and then sign in fail with 401/null. Add `emailVerifiedAt: "2026-01-01T00:00:00.000Z"` to those literal records (one edit per fixture, no logic changes) until the whole suite passes.

- [ ] **Step 5: Commit** `feat(auth): unverified owners read as signed out (rules 751-752)`.

### Task 2: Tokens, public links and scheduled jobs skip unverified owners

**Files:**
- Modify: `src/lib/mcp.ts` (`userFromBearer`), `src/lib/secretary-feed.ts` (`loginHolds`), `src/lib/schedule.ts` (`dailyRoster`), `src/lib/secretary-remind.ts` (the held/live split near line 158)
- Test: `tests/email-verify-jobs.test.ts`

**Interfaces:**
- Consumes: `emailVerified(u)` from Task 1.

- [ ] **Step 1: Write the failing tests:**
  - `bearer refuses an unverified owner` (rule 753): `newUser("b", { verified: false })`, `createMcpToken`, `userFromBearer(bearer(t))` is null; the same token works after setting `emailVerifiedAt`.
  - `dailyRoster leaves unverified owners out` (rule 755): one verified and one unverified owner; `dailyRoster().users` holds the verified email only and `idle` holds the unverified owner's scopes.
  - `reminders wait for an unverified owner`: seed a due reminder for an unverified owner the way `tests/secretary-phase2.test.ts` does; `sweepReminders` sends no email (mocked `sendEmail` not called) and the reminder is still there.
  - `feed and booking links refuse while the owner is unverified` (rule 756): `loginHolds({ login: owner.email, scope: owner.email, createdAt: <after createdAt> })` is false unverified, true once verified; same for a member record whose owner is unverified.

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-jobs.test.ts`. Expected: FAIL on all four.

- [ ] **Step 3: Implement.** `userFromBearer`: add `|| !emailVerified(u)` to the refusal line. `dailyRoster`: treat `!emailVerified(u)` like `u.suspended` (scopes go to `idle`, update the comment). `secretary-remind.ts`: hold scopes when `user.suspended || !emailVerified(user)`. `loginHolds`: owner branch refuses `!emailVerified(login.user)`; member branch refuses `!emailVerified(u)`. `media` and `golden` are untouched (spec §4).

- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): tokens, links and jobs wait for a verified owner (rules 753, 755, 756)`.

### Task 3: The code store

**Files:**
- Create: `src/lib/verify-email.ts`
- Test: `tests/email-verify-code.test.ts`

**Interfaces:**
- Produces:
  - `VERIFY = { ttl: 900, attempts: 5, gap: 60, perHour: 5, perIpHour: 20, movesPerDay: 3 } as const`
  - `issueVerifyCode(email: string): Promise<string>`: writes `verify:code:{email}` = `{ hash, sentAt }` with TTL 900, deletes `verify:tries:{email}`, returns the code.
  - `checkVerifyCode(email: string, typed: string): Promise<{ ok: true } | { ok: false; reason: "expired" | "wrong" | "locked"; attemptsLeft?: number }>`
  - `hasPendingCode(email: string): Promise<boolean>`
  - `markVerified(email: string): Promise<void>`: under `withUserLock`, sets `emailVerifiedAt` if absent and saves; then deletes both keys.
  - `verifyMail(u: Pick<User, "lang">, code: string): { subject: string; text: string }`
  - `normalizeCode(typed: string): string`

- [ ] **Step 1: Write the failing tests:**
  - `code is 6 digits and stored only as a hash`: `issueVerifyCode(e)` matches `/^\d{6}$/`; the raw stored record's JSON does not contain the code.
  - `right code passes once`: issue, `checkVerifyCode(e, code)` is `{ ok: true }`; the code is consumed by `markVerified`, after which `hasPendingCode(e)` is false.
  - `Arabic-Indic digits and spaces are accepted` (Review Focus 1): code "123456" (stub `randomInt` via `vi.spyOn(crypto, "randomInt")` or check by converting): `checkVerifyCode(e, "١٢٣ ٤٥٦")` is ok.
  - `five wrong attempts kill the code` (rule 758): four wrong answers report `attemptsLeft` 4,3,2,1; the fifth reports `locked`; then the right code reports `expired`.
  - `a new code replaces the old one`: issue twice; the first code is `wrong`, the second `ok`; attempts reset to 5.
  - `expired after the TTL`: `vi.useFakeTimers` or delete the key; check reports `expired`.
  - `mail copy`: Arabic subject contains the code and «ذكين», English subject contains the code and "Thakeen"; both texts say 15 minutes.

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-code.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/verify-email.ts`. Hash = SHA-256 hex of `nashr-verify:{email}:{code}`. Attempts: `db.incrby("verify:tries:{email}", 1)` then `db.expireNx(…, 900)` before comparing, so parallel guesses cannot exceed 5; past 5 delete both keys and answer `locked`. `normalizeCode`: map `٠-٩` and `۰-۹` to `0-9`, drop everything that is not a digit. Exact mail copy:
  - ar: subject `رمز التحقق في ذكين: {code}`, text `رمز التحقق: {code}\nصالح لمدة 15 دقيقة.\nإذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.`
  - en: subject `Your Thakeen code: {code}`, text `Your verification code: {code}\nIt works for 15 minutes.\nIf you did not ask for it, ignore this email.`

- [ ] **Step 4: Run** the test. Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): email verification codes (rules 757-758)`.

### Task 4: Send and check routes, and signup sends the first code

**Files:**
- Create: `src/app/api/auth/verify/send/route.ts`, `src/app/api/auth/verify/check/route.ts`
- Modify: `src/app/api/auth/signup/route.ts`
- Test: `tests/email-verify-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's functions, `currentUserUnverified`, `allow`, `clientIp`, `retryLater`, `mailReady`, `sendEmail`, `isProductionDeploy`.
- Produces (HTTP):
  - `POST /api/auth/verify/send` → 200 `{ ok: true, resendIn: 60 }`; 401 `{ ok: false }` with no unverified owner session (a member or a verified owner gets 409 `{ ok: false, error: "already_verified" }`); 429 `{ ok: false, error: "slow_down" }` + `Retry-After`; 503 `{ ok: false, error: "mail_unavailable" }`; 502 `{ ok: false, error: "send_failed" }` when `sendEmail` answers false.
  - `POST /api/auth/verify/check {code}` → 200 `{ ok: true }`; 400 `{ ok: false, error: "wrong_code", attemptsLeft }` / `"expired"` / `"locked"`; 401; 429 (per IP 60/hour).
  - Signup response adds `verify: true` and `mail: boolean`.
  - Under rule 766 only, the send response and the signup response add `devCode`.

- [ ] **Step 1: Write the failing tests** (mock `sendEmail` like `tests/revocation.test.ts`, capture the text):
  - `send mails a code to an unverified owner`; the mail goes to `u.email`, the text holds a 6-digit code, the response holds no `devCode` (`APP_ENV` unset).
  - `second send within 60 s is 429 with Retry-After 60` (rule 759); `sixth send in an hour is 429 with Retry-After 3600` (advance the gap by deleting `rate:verify:gap:{email}`); `21st send from one IP is 429`.
  - `mail_unavailable when mail is off` (rule 760): `vi.stubEnv("MAIL_FROM", "")`, 503 with that error, no code stored.
  - `check with the right code verifies` (rule 761): then `currentUser()` returns the account; `getUser(e).emailVerifiedAt` is set.
  - `double-submitted correct code answers ok` (Review Focus 5): a second check after success is 200 `{ ok: true }`.
  - `check refuses a wrong code with attemptsLeft`; `401 without a session`; `409 for a verified owner on send`.
  - `signup sends the first code` (rule 762): `POST /api/auth/signup` answers `verify: true`, one mail sent, `hasPendingCode(email)` true.
  - `devCode only under APP_ENV=test` (rule 766): `vi.stubEnv("APP_ENV", "test")` → send has `devCode` equal to the mailed code; with `VERCEL_ENV=production` also stubbed, no `devCode`.

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-routes.test.ts`. Expected: FAIL (routes missing).

- [ ] **Step 3: Implement the routes.** Send order: session → already verified → `mailReady()` → buckets `verify:gap:{email}` (1/60), `verify:hour:{email}` (5/3600), `verify:ip:{ip}` (20/3600), refusing with the refusing bucket's window → issue → `sendEmail` (on false, delete the code and answer 502). Check: session → already verified → `{ ok: true }` → bucket `verifycheck:ip:{ip}` (60/3600) → `checkVerifyCode` → `markVerified` on ok. Rule 766: `const exposeCode = process.env.APP_ENV === "test" && !isProductionDeploy()`. Signup: after `createSession`, if `mailReady()` issue and send (a failed send still answers `ok: true` with `mail: false`; the verify page offers resend); add `verify: true`.

- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): verify send and check routes, signup sends the first code (rules 759-762, 766)`.

### Task 5: Change a mistyped email

**Files:**
- Modify: `src/lib/verify-email.ts` (add `moveUnverifiedAccount`)
- Modify: `src/lib/referral.ts` (add `moveReferral`), `src/lib/partners.ts` (add `movePartnerRef`)
- Create: `src/app/api/auth/verify/email/route.ts`
- Test: `tests/email-verify-change.test.ts`

**Interfaces:**
- Produces:
  - `moveUnverifiedAccount(from: User, to: string): Promise<"ok" | "exists" | "not_allowed" | "limit">`
  - `moveReferral(from: string, to: string): Promise<void>`: if `referredBy:{from}` names a referrer: set `referredBy:{to}`, move the pending hash field (`who(from)` → `who(to)`, same value), replace the `referrals:{referrer}` list entry whose `email === from` (lrange, lrem that exact string, lpush the same JSON with `email: to`).
  - `movePartnerRef(partner: string, from: string, to: string): Promise<void>`: `srem` + `sadd` on `partner:refs:{partner}`.
  - HTTP `POST /api/auth/verify/email {email}` → 200 `{ ok: true, email }`; 400 `bad_email`; 403 `not_allowed`; 409 `exists`; 429 `slow_down` (`limit` and the send buckets); 401.

- [ ] **Step 1: Write the failing tests:**
  - `refused without gatedSignup` (rule 763): an owner record with no `gatedSignup` gets 403.
  - `refused after verification`: 403.
  - `refused to a taken owner address` and `refused to a member login address` (Review Focus 4): 409.
  - `moves the account` (rule 764): an unverified gated owner with a referral applied at signup and a partner attribution. After the move: `getUser(new)` has the same name, phone, passHash, lang, plan, credits, trialEnds, createdAt, sessionsAfter, gatedSignup, referredBy, firstMonthOffer; `getUser(old)` is null; `ownerOf(codeFor(new))` is the new email; `referredBy:{new}` is the referrer; the referrer's list shows the new address, not the old; `partner:refs:{partner}` holds new, not old; the cookie now resolves (`currentUserUnverified`) to the new email; a code was mailed to the new address; the old session token no longer resolves.
  - `three moves a day, the fourth is 429` (rule 765): the counter carries across moves.

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-change.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `moveUnverifiedAccount`: refuse `not_allowed` unless `from.gatedSignup && !from.emailVerifiedAt`; `limit` when `emailMoves.day` is today (UTC `YYYY-MM-DD`) and `n >= 3`. Take `withLoginLock` on both addresses, outer lock on the alphabetically smaller one (avoids deadlock; lock order in `src/lib/team.ts` §27 unchanged). Inside: `getLogin(to)` → `exists`; save the new record (carried fields above, `email: to`, `emailMoves` incremented); `registerCode(to)`; `moveReferral`; `movePartnerRef` when `from.referredBy?.partner`; then `wipeAccount(from.email)` (deletes `user:{old}`, its login index, codes, sessions resolve to nothing). Delete `verify:code:{old}` and `verify:tries:{old}`. Route: validate (`normalizeEmail`, `validEmail`), call it, then `destroySession()` + `createSession(to)`, then issue and send a code to `to` through the same send buckets as Task 4 (extract the send sequence from the send route into `sendVerifyCode(u: User, req: Request): Promise<Response | null>` in `verify-email.ts` so both routes share it).

- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): fix a mistyped signup email before verifying (rules 763-765)`.

### Task 6: Verify page, layout redirect and the forms

**Files:**
- Create: `src/app/[lang]/app/verify/page.tsx`, `src/components/app/VerifyForm.tsx`
- Modify: `src/app/[lang]/app/layout.tsx` (redirect, `PUBLIC` list), `src/components/app/AuthForm.tsx` (`SignupForm` after success)
- Modify: `e2e/fixtures/accounts.ts` (`signUpOrLogIn` verifies with `devCode`)
- Test: `tests/email-verify-page.test.ts`; switch Task 1's caller-list test from `it.todo` to `it`

**Interfaces:**
- Consumes: Task 4 and 5 routes; `hasPendingCode`; `safeNext` from `src/lib/safe-next.ts`.
- Produces: `VerifyForm({ lang, email, canChangeEmail, autoSend, mailOn, whatsapp, next })`.

- [ ] **Step 1: Write the failing tests** (source-level where a render needs Next internals, as `tests/logout-visible.test.ts` does):
  - `layout sends an unverified owner to verify` (rule 754): the layout source calls `currentUserUnverified()` only when `currentUser()` is null and redirects to `/${lang}/app/verify`; `PUBLIC` contains `"/verify"`.
  - `verify page`: redirects to login when `currentUserUnverified()` is null; to `/${lang}/app` when the actor is not `owner` or the account is verified; passes `autoSend = !(await hasPendingCode(email))` (Review Focus 2) and `canChangeEmail = !!u.gatedSignup`.
  - `VerifyForm`: input has `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength` ≥ 6 with Arabic digits allowed; resend button disabled while the countdown runs; calls `/api/auth/verify/send` in an effect only when `autoSend`; change-email form only when `canChangeEmail`; contains `LogoutButton`; shows the WhatsApp link on `mail_unavailable`.
  - `signup goes to verify`: `SignupForm` pushes `/${lang}/app/verify?next=` + the encoded old destination (the `next` param or the start page with `url`).

- [ ] **Step 2: Run** `npx vitest run tests/email-verify-page.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Page copy (Arabic / English): title «تحقق من بريدك» / "Check your email"; body «أرسلنا رمزاً من 6 أرقام إلى {email}» / "We sent a 6-digit code to {email}"; button «تأكيد» / "Confirm"; resend «إرسال رمز جديد» / "Send a new code" with «بعد {n} ث» / "in {n}s"; wrong code «الرمز غير صحيح. باقي {n} محاولات» / "Wrong code. {n} tries left"; expired or locked «انتهى الرمز. اطلب رمزاً جديداً» / "This code has ended. Ask for a new one"; change email «البريد خطأ؟ غيّره» / "Wrong email? Change it"; mail off «لا نستطيع إرسال البريد الآن. راسلنا على واتساب» / "We cannot send email right now. Message us on WhatsApp". After success: `window.location.assign(safeNext(next) || \`/${lang}/app\`)`. Layout: when `!user`, `const pending = !isPublic && path ? await currentUserUnverified() : null; if (pending?.actor?.kind === "owner") redirect(\`/${lang}/app/verify\`)` before the login redirect. E2E: after signup, `POST /api/auth/verify/check` with the response's `devCode`.

- [ ] **Step 4: Run** `npm run check`. Expected: PASS, including the caller-list test.

- [ ] **Step 5: Check in the browser** (dev server, `.claude/launch.json`): sign up a new account, land on `/ar/app/verify`, read the code from the dev response, confirm, land on the start page; open `/ar/app` with a second unverified account and see the redirect; 375 px width has no horizontal scroll.

- [ ] **Step 6: Commit** `feat(app): verify page and the redirect to it (rule 754)`.

### Task 7: Docs, rules and the final build

**Files:**
- Modify: `docs/system/flows.md` (new section: signup → verify, login → verify, existing accounts, change email; next free § number on `main`), `docs/system/permissions.md` (§1.1 three new routes, §2 verify page, the gate in §0), `docs/system/architecture.md` (`verify-email.ts` row; keys `verify:code:*`, `verify:tries:*`, rate buckets), `docs/system/tests.md` (rows 751-766 as below)

- [ ] **Step 1: Write the rows.** 751 gate in the resolver; 752 caller allowlist; 753 bearer; 754 layout redirect; 755 jobs skip; 756 links refuse; 757 code shape and storage; 758 five attempts; 759 send limits; 760 mail_unavailable; 761 success sets `emailVerifiedAt` under the lock; 762 signup sends the first code; 763 change email only gated and unverified; 764 change email moves the listed fields and wipes the old record; 765 three a day and taken addresses; 766 `devCode` only under `APP_ENV=test` off production. Each names its test file, status `done`.

- [ ] **Step 2: Run** `grep -nE '^\| 7(5[1-9]|6[0-6]) ' docs/system/tests.md | wc -l`. Expected: `16`, and no other row uses those numbers.

- [ ] **Step 3: Run** `npm run check` and `npx next build`. Expected: both pass (if `next build` is blocked locally, the Vercel preview on the PR is the build proof).

- [ ] **Step 4: Commit** `docs(system): email verification flows, permissions, keys and rules 751-766`, push, and update PR #286's description to say it now carries the implementation.

- [ ] **Step 5: Release note for the founder (in the PR body):** after merge every owner, the founder included, meets the gate on the next request; their automations and booking links pause until they verify; Resend must stay configured on Hostinger.
