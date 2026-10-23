# better-auth and oRPC behind a switch (design)

Status: **design**, written 2026-10-23 on branch `claude/sup-foundation-migration` from main `42dd8fb1`. Founder decision of 2026-10-23: move the sign-in engine to better-auth and the typed API to oRPC "the way Supastarter does it" (`~/projects/supastarter`, read only: better-auth 1.7.7, oRPC 1.15.4). Rules **3400-3499** are reserved (3400-3434 used here; coverage in `docs/system/tests/3400-better-auth-orpc.md`). Release step: **expand**. Nothing changes for a live customer until the founder sets the switch; with it off, behaviour, cookies, routes and stored data are exactly as on main.

## 1. Current and target

| Area | Today (main `42dd8fb1`) | Target (switch on) |
|---|---|---|
| Password sign-in | `POST /api/auth/login` → `getLogin` → `verifyPassword` (bcryptjs) → `finishLogin` | `POST /api/better-auth/sign-in/email` (better-auth's endpoint, bcryptjs hash/verify) → the same account checks and two-step challenge, through a session gate (section 4) |
| Magic link | none | `POST /api/better-auth/sign-in/magic-link` (better-auth's magic-link plugin), mail through `sendEmail` in Arabic and English; the link opens `/{lang}/app/magic#t=…`, which posts the token to `POST /api/auth/magic` |
| Session read | `currentUser()` reads `thakeen_session`, resolves through `resolveSession` | unchanged for every server caller; better-auth's `GET /get-session` answers from the same record and the same resolver |
| Sign-out | `POST /api/auth/logout` → `destroySession` | also `POST /api/better-auth/sign-out`, which ends in `destroySession` |
| Two-step code | `src/lib/mfa.ts`, `POST /api/auth/login/mfa` | unchanged; the better-auth gate opens the same challenge |
| Passkeys | `src/lib/passkeys.ts`, `/api/auth/passkey/*` | unchanged routes; their list is also an oRPC procedure |
| Google | `/api/auth/google/*` | unchanged routes; better-auth's Google provider is configured but gated by the code constant `BA_GOOGLE = false` (section 9) |
| Typed API | REST only | `POST /api/rpc/*` (oRPC `RPCHandler`) next to REST; typed client and TanStack Query utils; the security settings screen uses it first |
| Client | `fetch` + `src/lib/auth-client.ts` | better-auth React client (`createAuthClient` with `magicLinkClient`) + TanStack Query hooks `useSessionQuery`, `useUserAccountsQuery`, `useUserPasskeysQuery` |

REST stays for the PWA, the crons, MCP and every route not listed here.

## 2. The switch (rules 3400, 3401)

`AUTH_ENGINE=better-auth` turns the new engine on. It is read at call time (`authEngine()` in `src/lib/auth-engine.ts`), never at build time, so the same build serves both and a rollback is one variable. It also needs `BETTER_AUTH_SECRET` (at least 32 characters, used to sign the cookie better-auth reads internally). Missing, short or any other value of `AUTH_ENGINE`: the legacy engine, with nothing logged that contains a value.

With the switch off:
- `/api/better-auth/*` and `/api/rpc/*` answer 404 before reading the body or the store.
- `createSession`, `destroySession`, the log-in form and the security screen run the code of main, byte for byte; no new cookie, no new key, no new field.
- The login page renders no tab switch.

## 3. Data mapping: an adapter that reads the stored records (rules 3403-3409)

The brief allowed a migration script or an adapter that reads the existing records. **Choice: the adapter.** Reasons: (1) a copy would be a second source of truth for passwords, links and sessions, which every revocation stamp (`sessionsAfter`, `devicesAfter`, `teamSessionsAfter`, suspension) would then have to reach; (2) the multi-workspace work (M1-M4) is still moving the person and membership records, and a copy would freeze one moment of an expand/contract sequence; (3) nothing has to be written, so there is nothing to roll back. The script in step (f) is therefore a read-only readiness check (section 10).

`createAdapterFactory` (better-auth 1.7.10) with a custom adapter, `supportsDates: false`, `supportsJSON: false`, `supportsBooleans: true`, `supportsArrays: false`, no transactions. Joins are not native: better-auth's fallback join issues one `findOne`/`findMany` per joined model.

| better-auth model | Read from | Writes |
|---|---|---|
| `user` | by `email`: `getLogin(email)`; by `id`: `getPerson(pid)`, then `getLogin(person.email)` with `l.pid === pid`. `id` = the person id, `email` = the login address, `name` = the person's name, `emailVerified` = **true** (section 4.4), dates from the person | none: `create`, `update`, `delete` refuse (better-auth's sign-up, profile and deletion paths are closed anyway, section 5) |
| `account` | for a user: `credential` (`accountId` = `userId` = pid, `password` = `person.passHash`) when the person has a hash; `google` (`accountId` = the Google `sub`) when `googlesub:{login}` names a sub whose `google:{sub}` points back at this login | none |
| `session` | `session:h:{sha256(token)}` (and the raw key of rule 1345 for a 64-hex token), only when the session gate's resolver accepts it (rule 3406) | `create`: only for a token the gate approved in this request (rule 3407), written by the same function as `createSession`; `delete`: `dropSession` + `forgetDevice`; `update`: refused (refresh is off) |
| `verification` | `ba:verify:{sha256(identifier)}` (new, `globalKey.baVerify`), TTL from `expiresAt` | `create` with TTL, `delete`, consume = `GETDEL` (single use under concurrency) |

Every key comes from `src/lib/keys.ts`. No `await db.*` inside a loop: `findMany(account)` reads its two keys in one `Promise.all`.

### 3.1 The session record

One record, the legacy shape plus better-auth's fields:

```
session:h:{sha256(token)} = { email, at, pid?, acct?,            // legacy Session (unchanged meaning)
                              id, userId, expiresAt, createdAt,   // better-auth
                              updatedAt, ipAddress, userAgent }    // better-auth
```

The raw token is never stored (rule 1345 holds). Every legacy reader ignores the extra fields; `setSessionAccount` spreads the record, so a workspace switch keeps them. The TTL is the time to `expiresAt` (30 days, `SESSION_TTL`; refresh is off, so a session never outlives that). The legacy fields are written by the same code as today (`sessionIds`, `recordDevice`), so `currentUser`, the device list and every stamp treat a better-auth session exactly like a legacy one.

## 4. Session continuity and the one cookie (rules 3410-3412)

**Nobody is signed out at cutover, and nobody at rollback.** There is one session cookie: `thakeen_session`, the raw token, as today.

- better-auth wants its own signed cookie (`{prefix}.session_token` = `token.HMAC`). The route handler `/api/better-auth/[...all]` therefore rewrites every request before better-auth sees it: it drops any better-auth session cookie the browser sent and, when `thakeen_session` is present, adds the better-auth cookie signed from that token with `BETTER_AUTH_SECRET` (the same `HMAC-SHA256` + base64 format as `better-call`'s `signCookieValue`). better-auth therefore always reads exactly the session `currentUser` reads.
- On the way out it strips better-auth's own session `Set-Cookie` headers (`session_token`, `session_data`, `dont_remember`). The legacy cookie is set by the adapter's session `create` through `next/headers` `cookies()` (merged into the route's response by Next, `appendMutableCookies`), with the same options as `createSession` (`sessionCookie`).
- `sign-in/email` answers JSON that would carry `token`; the wrapper removes it (a session token never reaches JavaScript) and adds `verify: true|false` for an owner, as `POST /api/auth/login` does.

So:
- **Cutover (switch on):** every existing `thakeen_session` cookie keeps working for every server caller, and better-auth's `get-session` answers it on the first request. No record is rewritten.
- **Switch off again, or a code rollback to main:** every session created while on is a legacy-shaped record behind a legacy cookie; main reads it unchanged.
- **Founder impersonation and console staff login:** untouched. An impersonation record (`imp`) is never a better-auth session: `get-session` answers `null` for it, and server code keeps `currentUser`.

### 4.1 The session gate (rule 3411)

`databaseHooks.session.create.before` runs for every session better-auth would mint:
1. Only from `/sign-in/email` and `/magic-link/verify` (and `/callback/:id` once `BA_GOOGLE` is on); any other path throws.
2. Re-resolves the login: `getPerson(userId)` → `getLogin(person.email)`, and refuses when `l.pid !== userId`.
3. Ends an expired suspension (`endExpiredSuspension`) and runs `loginRefusalCode`, the code behind `loginRefusal` (suspended with `until`, member of an unverified owner, disabled member, invalid). The refusal goes back as better-auth's `APIError` with Thakeen's code.
4. Two-step sign-in on (`mfaActive(email, bornAt(l))`): opens the same challenge as today (`openChallenge(email, "password")`; a magic link counts as the first factor, and the stored `via` stays one of today's values, so the challenge shape does not change) and throws `mfa_required`: **no session exists** (rule 1934). The code step stays `POST /api/auth/login/mfa`, which ends in `finishLogin` → `createSession`.
5. Otherwise it replaces better-auth's 32-character token with Thakeen's 64-hex one and records the approval for the adapter's `create` (an in-process map keyed by the token, consumed once).

`databaseHooks.session.create.after` counts the login (`track`), as `finishLogin` does.

### 4.2 Passkeys and Google

Both keep their own routes and end in `finishLogin` → `createSession`, which writes the same record either way. No better-auth passkey or two-factor plugin: `@better-auth/passkey` pins `@simplewebauthn/server` 13 against our 14.0.3 and stores another credential shape; better-auth's two-factor plugin encrypts its secret with its own key and stores recovery codes another way. Both would need a second store or a rewrite of every enrolment.

### 4.3 Sign-out

`/sign-out` deletes the record through the adapter (`dropSession`, `forgetDevice`) and the wrapper calls `destroySession`, which also clears `thakeen_session` (and the legacy `nashr_session`).

### 4.4 Why `emailVerified` is projected as true

The magic-link plugin calls `revokeUnprovenAccountAccess` for a user whose `emailVerified` is false: it deletes every account link (the password, Google) and every session, then marks the address verified. That would erase a Thakeen owner's password. Thakeen's own verify gate (rule 767, `currentUser` vs `currentUserUnverified`, the `verify` answer of rule 754) stays the only one, and the magic link is sent only to an address that may sign in (section 6), so better-auth never runs that path.

## 5. The endpoint and what it exposes (rules 3413, 3414)

`/api/better-auth/[...all]` (basePath `/api/better-auth`; `/api/auth/*` stays Thakeen's). An **allow-list** in the wrapper, not better-auth's deny-list, so an upgrade that adds an endpoint adds nothing reachable:

| Method + path | Why open |
|---|---|
| `POST /sign-in/email` | password sign-in |
| `POST /sign-in/magic-link` | send a link |
| `GET /get-session` | the client's session hook |
| `POST /sign-out` | sign-out |
| `GET /list-accounts` | the client's linked-methods hook |

Everything else answers 404: sign-up (Thakeen's sign-up keeps its checks: captcha, invite-only, trial), `/magic-link/verify` over GET (it carries the token in a query string, rule 546; the verify runs server-side from `POST /api/auth/magic`), password reset and change, email change, update-user, delete-user, list/revoke sessions (rules 1938-1941 need the password), link/unlink, social sign-in and callbacks.

Rate limits are Thakeen's (`allow` in `src/lib/rate.ts`), applied in the wrapper before better-auth reads anything; better-auth's own limiter is off. `sign-in/email` shares the log-in buckets (`login:ip:{ip}` 20/900 s, `login:em:{email}` 8/900 s). `sign-in/magic-link` shares the reset link's shape (`magic:ip` 8/900 s, Turnstile when configured, `magic:em` 3/900 s). `POST /api/auth/magic` uses `login:ip`. CSRF: the proxy's `crossSiteRefusal` covers both new paths (they are not in `CROSS_SITE_EXEMPT`), and better-auth's own origin check stays on with `trustedOrigins` = `appOrigin()`.

## 6. Magic link (rules 3415-3417)

- Request (rule 3415): `POST /api/better-auth/sign-in/magic-link` `{email, lang, turnstile?}`, kind `magic` in the allow-list. The wrapper (`magicRequest` in src/lib/better-auth/handler.ts) checks the address shape (400 `bad_email`), the per-IP bucket `magic:ip:{ip}` (8 per 15 minutes) before Turnstile (rule 427: a token costs an outbound call), Turnstile when configured (`captcha_failed`), the per-address bucket `magic:em:{email}` (3 per 15 minutes), and only then calls better-auth, and only for an address `magicEligible` lets in (a login `loginRefusalCode` lets in and that does not owe the address code: an unverified owner uses the password and the verify page) while mail is configured. Every other address, an address over a limit and a mail provider that is not ready get the same answer, `{ok: true, status: true, mail}` (`mail` says only whether delivery is configured, as the reset form reads it), so the form never tells whether an address has an account and an unknown address costs no stored row. Only `{email, metadata: {lang}}` reaches better-auth: no `callbackURL`, no `name`, no browser metadata. `sendMagic` checks eligibility again before mailing.
- Token: 32 letters from better-auth, stored hashed (`storeToken: "hashed"`: identifier `magic-link:{base64url(sha256(token))}`, then the adapter keys the row by the SHA-256 of that), 15 minutes (`MAGIC_TTL_SECONDS`, also the Redis TTL), single use (`GETDEL`, two racing presses: one wins).
- Link: `{appOrigin}/{lang}/app/magic#t={token}`, the token in the fragment (rule 546). better-auth's own URL (token in a query string) is never mailed.
- Verify (rule 3416): the page `/{lang}/app/magic` (only while the switch is on; with it off the path is as on main: the layout sends a signed-out visitor to log-in, a signed-in one gets the 404) reads the token from the fragment once, strips it from the address bar and history, and posts nothing on load (mail scanners open links and run scripts). The person's press posts `{token}` to `POST /api/auth/magic` (log-in IP bucket 20 per 15 minutes, 404 when off), which runs `auth.api.magicLinkVerify` server-side (`verifyMagic` in handler.ts, `asResponse`, no `callbackURL`: better-auth answers JSON), so the token never appears in a URL any server receives and better-auth's GET endpoint stays off the allow-list. better-auth reports a dead link as a redirect to `?error=`: `INVALID_TOKEN`, `new_user_signup_disabled` and `user_not_found` answer `bad_token`, anything else `failed`. The verify ends in the session gate (`/magic-link/verify` is one of the two gate paths): refusals with their legacy codes, the two-step challenge (`mfa_required`, the challenge cookie, no session; the page sends the person to `/login?mfa=1`), then the session and the log-in answer (`verify: true` for an owner who owes the address code cannot happen: no link is sent to one). `/magic` is public in the app layout only while the switch is on, and a person page (`PERSON_PAGES`, never under `w/{handle}`).
- Mail: `sendEmail({to, subject, text, template: "magicLink", context: {link}, locale})` with the new template (src/emails/magic-link.ts, copy in src/emails/copy.ts): Arabic (RTL, `dir="rtl"` on every container, rules 685-688) and English, the 15-minute single-use note, the fallback link, the ignore line. Language from the form.
- Log-in tab (rule 3417): with the switch on, the log-in form shows the shared `Tabs` (rule 1113) with "Password" and "Email link"; `?tab=link` opens the second (the magic page's "request a new link"). The password tab posts to `/api/better-auth/sign-in/email` (same two fields, same answer shape); passkeys (button and autofill) live in the password tab only. With the switch off the form, its markup and its request are main's.
- `disableSignUp: true`: a link never creates an account.
- Known limits: an eligible address takes longer to answer than an unknown one (a database read and a mail call), the same side channel as the reset form; a magic link proves the address and is a first factor only, so two-step sign-in still asks for the code.

## 7. React client and hooks (rules 3418-3420)

- `src/lib/better-auth/client.ts`: `createAuthClient({ basePath: "/api/better-auth", plugins: [magicLinkClient()] })` from `better-auth/react`.
- `src/lib/better-auth/hooks.ts`: `useSessionQuery` (`authClient.getSession`), `useUserAccountsQuery` (`authClient.listAccounts`), `useUserPasskeysQuery` (oRPC `account.passkeys.list`), query keys exported for invalidation, as Supastarter's `modules/saas/auth/lib/api.ts`.
- `src/lib/rpc/query-client.ts`: `createQueryClient` (staleTime 60 s, retry off) and a `QueryProvider` client component, mounted only on screens that use it while the switch is on.
- Log-in form: with the switch on, a Password / Magic link tab switch (`role="tablist"`, arrow keys, logical CSS so RTL mirrors); the password tab posts to `/api/better-auth/sign-in/email` and maps the error codes to the existing messages; the magic tab posts to `/sign-in/magic-link` and shows "check your inbox". With it off, the form of main.

## 8. oRPC (rules 3421-3424)

- `POST /api/rpc/[[...rest]]` → `RPCHandler(router)` with `prefix: "/api/rpc"`; 404 while the switch is off.
- `protectedProcedure`: `currentUser()` (Thakeen's resolver, brand and workspace selectors included), 401 without it; `forbid()` gates as on REST. Context: `{ user, headers }`. Better-auth's `getSession` is not used here, so impersonation, staff and member rules stay those of REST.
- Procedures, each calling the same lib function as its REST route (moved into `src/lib/account-security.ts`, the REST route now calls it too, answers unchanged):
  - `session.me`: who is signed in (email, name, kind, verified) for the client.
  - `account.devices.list` ≡ `GET /api/account/sessions`.
  - `account.devices.revoke({id, password})` ≡ `DELETE /api/account/sessions` (same password, same `signoutothers:{login}` limit, same `sessions.revoke` gate).
  - `account.passkeys.list` ≡ `GET /api/account/passkeys`.
  - `account.methods`: password set, Google linked, passkey count, two-step on.
- `src/lib/rpc/client.ts`: `createORPCClient(new RPCLink({ url: origin + "/api/rpc" }))` typed by `RouterClient<typeof router>`, `orpc = createTanstackQueryUtils(client)`.
- First screens: the security settings page passes `rpc` when the switch is on; `DeviceList` and `PasskeySettings` then read their lists through `orpc.*.queryOptions()` and revoke through the mutation; off, the `fetch` of main.

## 9. Google through better-auth (rule 3425, not switched on)

`socialProviders.google` is configured from the existing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` with `disableImplicitSignUp: true` and account linking off, but only when the code constant `BA_GOOGLE` is true, and it is **false**: better-auth's callback is `/api/better-auth/callback/google`, a redirect URI the founder must add in the Google console first. Until then the legacy Google routes are the only Google sign-in, and they already end in the shared `createSession`.

## 10. The script (rule 3426)

`scripts/better-auth-check.ts`: walks `users:all` and the login indexes in batches (`pmap`), projects each login through the adapter's pure mapping functions and reports counts: logins with a password, with Google, with neither (no way in once the switch is on except a magic link), persons whose login index disagrees, sessions without `pid`. Dry run only: `--apply` is refused with "nothing to apply" because the adapter reads the stored records directly. It never prints an address, a hash or a token, only counts and record kinds.

## 11. Cutover and rollback

1. Merge this branch (expand). The switch is off: nothing changes; the new routes answer 404.
2. Founder sets `BETTER_AUTH_SECRET` (`openssl rand -base64 48`) and `AUTH_ENGINE=better-auth` on **staging**, signs in with a password, a magic link, a passkey and Google, checks the security screen. Then production.
3. Rollback: unset `AUTH_ENGINE` (or set any other value). Every session stays valid; the magic-link mails already sent stop working (their page then answers "link expired").
4. Contract (later release, after a month on): the legacy `POST /api/auth/login` and the form's legacy path go; `AUTH_ENGINE` becomes the only path. Not part of this change.

## 12. Risks

| Risk | Mitigation |
|---|---|
| better-auth upgrade adds an endpoint | allow-list (rule 3413), exact pin |
| better-auth mints a session outside the gate | the adapter refuses a token the gate did not approve (rule 3407) |
| A refusal or two-step check differs between the two paths | one code function (`loginRefusalCode`), one `mfaActive`, tests run both paths on the same fixtures |
| Session token in JSON | removed by the wrapper (rule 3412), tested |
| better-auth's internal session refresh rewrites records | `disableSessionRefresh`, cookie cache off, `update(session)` refused |
| Cookie name collision | better-auth's cookies use the `thakeen.` prefix and never reach the browser |
| Lockfile drops Linux bindings | regenerated in an empty directory with npm 11.19.1, `@rolldown/binding-linux-*` checked (rule 3402) |
| `next build` blocked in the sandbox | reported, not worked around |
| Supply chain | exact pins older than 7 days (`.npmrc` `min-release-age=7`), `npm audit` |

## 13. Step order (one commit each, `npm run check` green at each)

a. deps (better-auth 1.7.10, @orpc/server, @orpc/client, @orpc/tanstack-query 1.15.7, @tanstack/react-query 5.104.3) + switch + Redis adapter + tests.
b. better-auth server config + route + session gate + `createSession`/`destroySession` sharing (password, sessions, two-step, passkeys/Google through the shared session).
c. magic link: plugin, mail template, `POST /api/auth/magic`, `/app/magic` page, login form tab.
d. React auth client + query hooks.
e. oRPC router, route, typed client, security screen.
f. readiness script.
g. docs: architecture, flows, permissions, variables, tests/3400.
