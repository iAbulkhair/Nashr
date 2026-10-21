# Account id: a stable storage key separate from the sign-in address

Status: proposed on 2026-10-16. Not built and not decided by the founder. The defaults in "Decisions" are the coordinator's call, and the founder can overturn any of them. Written against `origin/claude/beautiful-blackburn-50e6d7` at `52293e40`, which is draft PR #376 (the customer account-security pack, rules 1930-1956) on top of `main` `e3b9f708`. Line numbers below are on that ref.

Rules reserved: 1980-1999. They were released by the mail/logs/tooling session and claimed in the shared notes on 2026-10-16. Permission-row numbers and the flows section number are assigned when this is built. This file is a spec only: no code changes, nothing on production.

## ملخص للمؤسس

- **اليوم:** كل بيانات الحساب مخزّنة تحت بريد المالك نفسه. هذا يشمل المهام والملفات والمحادثات والهوية والربط والرصيد والبطاقة والفريق. لهذا PR #376 يسمح بتغيير البريد فقط لحساب جديد ما فيه شغل، وأي مالك عنده شغل يُحوَّل للدعم.
- **الحل:** كل حساب له «رقم حساب» ثابت ما يتغيّر أبداً، وفهرس صغير يربط بريد الدخول بهذا الرقم. تغيير البريد يصير تعديل سطرين: الفهرس وحقل البريد. البيانات نفسها ما تتحرّك.
- **الحسابات الحالية:** رقمها يصير بريدها الحالي، مجمّداً. معناه أنه ما في نقل بيانات ضخم ولا مخاطرة بفقد شيء. الحسابات الجديدة تأخذ رقماً عشوائياً.
- **ثلاثة إصدارات حسب قاعدة 679:**
  1. **التوسيع:** الكود يقرأ بالطريقتين ويتصرّف تماماً مثل اليوم. بعده سكربت يبني الفهرس للحسابات الحالية، يشغَّل بموافقتك.
  2. **التفعيل:** الحسابات الجديدة برقم عشوائي، والمالك يقدر يغيّر بريده حتى لو عنده شغل. بعد هذا الإصدار ما نرجع لما قبل الإصدار الأول.
  3. **التنظيف:** نحذف القراءة القديمة.
- **لا يتأثر:** بطاقة Paymob تبقى مع الحساب، وربط Composio ما يتأثر (معرّفه مبني على نطاق الحساب، والنطاق ما يتغيّر)، والمهام المجدولة تمشي كما هي.
- **قرارات بأسماء افتراضية تقدر تغيّرها** (في قسم Decisions):
  - البريد القديم محجوز 30 يوماً، مع رابط «ما كنت أنا» يرجع البريد خلال 7 أيام.
  - رمز المصادقة مطلوب لتغيير البريد إذا كانت الخطوتان مفعّلة.
  - البريد القديم يبقى داخل أسماء المفاتيح للحسابات الحالية، لأن تنظيفه نقل بيانات كامل ومؤجَّل.
- **ملاحظة على PR #376 الآن:** فحص «الحساب فيه شغل» ما يشوف مهام ريم ولا التعليمات ولا الحوكمة وغيرها. فمالك تجربة عنده مهام عند ريم ممكن يغيّر بريده ويخسرها. التفاصيل في آخر الملف.

## Goal

An owner whose account already holds work can change the address they sign in with, from settings, with no support ticket. No data moves, and no other tenant's data becomes reachable at any point, rollbacks included. The end state matches the supastarter model: a user id that never changes, and an email that is just a login and contact field.

## Today

### How every key gets its owner

- `sc(u) = u.scope ?? u.email` (`src/lib/auth.ts:218`). `scope` exists only at runtime and is stripped by `saveUser` (`auth.ts:273`).
- `scopeFor(email, brandId)` returns `email` for the default brand and `` `${email}#${brandId}` `` for an added one (`src/lib/brands.ts:65-67`). `validEmail` bans `:` and `#` (`auth.ts:238`), so scopes cannot collide.
- `resolveSession` (`auth.ts:497`) reads the session's login. It then reads `user:{login}` (owner) or `member:{login}`, whose `memberOf` names the owner email. The scope is always built from the OWNER email, so a member's address is never a scope.
- The account record is `user:{email}` (`auth.ts:260-276`), and `saveUser` adds the email to `users:all`.
- `getLogin(email)` (`auth.ts:552`) is "owner if `user:{e}` exists, else member if `member:{e}` is on the owner's roster".

As a result, the owner's address is the primary key of the tenant. It appears in about 190 persistent key families (about 150 per scope, about 40 per owner or per login), plus about 75 rate-limit bucket names. No code uses SCAN or KEYS: every account is reached through `users:all` (`dailyRoster`, `src/lib/schedule.ts:238-257`).

### What PR #376 does with an address change

- **`src/lib/email-change.ts`:**
  - The code goes to the NEW address.
  - A member moves through `moveMemberLogin` (`src/lib/team.ts:373`).
  - An owner moves through `moveOwnerLogin` (`src/lib/verify-email.ts:193-236`), but only when `ownerHasData(u)` is false. Otherwise the answer is `owner_has_data` (rule 1944).
- **`moveOwnerLogin`:**
  - Takes both `lock:login` locks (alphabetical order), then the old address's user lock.
  - Writes `user:{to}` as a copy with a fresh `sessionsAfter`.
  - Copies `mfa:{login}` (`carryLogin`), registers a new referral code, and moves the referral and partner links.
  - Then runs `wipeAccount(old)`. Nothing per scope is carried, which is why only an empty account may use it.
- **`ownerHasData`** refuses any of these:
  - a paid, partner, founding or top-up field;
  - more than one brand;
  - `brand:{e}`, `mcptoken-of:{e}`, `paymob:card:{e}` or `chatm:{e}:trial`;
  - a non-empty `files:`, `conns:`, `members:` or `invites:`;
  - a first entry in `tasks:` or `convs:`.

## Design

### 1. Account id

- **`User.id`** is the account's storage key. It never changes for the life of the account.
- **Legacy accounts** (every account that exists before release 2): `id` = the account's email at the moment the conversion script or the first save writes it. It is frozen from then on, so after a move it no longer equals `User.email`. A legacy id contains `@`.
- **New accounts** (from release 2): `id = "a_" + base32(crypto.randomBytes(15))`. That is 26 characters with no `@`, `:` or `#`, from `crypto` (never `Math.random`). It is never put in a URL or shown to the customer; there is no need, and it keeps ids out of logs that leave the app.
- **`User.email`** becomes what the name says: the sign-in and contact address. Mail goes there, display uses it, and Paymob `billing_data.email` uses it. It is never a key.
- **`acct(u) = u.id ?? u.email`** (release 1; it becomes `u.id` in release 3). It is the only way code turns a `User` into a key prefix.
- **`sc(u)`** keeps its meaning (the scope), built as `scopeFor(acct(owner), brandId)`. For a legacy account the scope string is byte-for-byte what it is today, so no per-scope key is renamed. This is the point of the design.

### 2. Login index

- `login:{normalizedEmail}` holds `{ kind: "owner", id }`. It is written only under `lock:login:{email}`, with `SET NX`, so two signups or moves that race for one address cannot both win.
- Members keep `member:{login}`, which is already keyed by login. Their `memberOf` now names the owner's account id; for a legacy owner that is the same string as today.
- **`getLogin(email)`** (resolving a LOGIN) is used only by sign-in, signup, forgot/reset password, Google sign-in, the address-change "is it taken" check and the console's user lookup. It runs in this order:
  1. `login:{e}` names an id: load `user:{id}`.
  2. Otherwise `member:{e}`, as today.
  3. Otherwise the legacy fallback: `user:{e}` counts only if the record has no `id`, or `id === e` AND `email === e` (rule 1981). This guard matters. After a legacy account moves from X to Y its record stays at `user:X` with `email: Y`. Without the guard, forgot-password on X (a mailbox the owner may have given up) would reset the moved account's password, and a signup with X would be refused or would land on it. With the guard, X resolves to nothing, and a new signup with X becomes a separate account with an opaque id that never touches `user:X`.
- **`getAccount(id)`** (resolving an ACCOUNT) is a plain `user:{id}` read with no email check. It serves every pointer that already names an account:
  - `memberOf` and `invite.owner`;
  - the `mcptoken:{hash}` value and OAuth codes and refresh tokens;
  - Paymob intents and transactions;
  - feed and booking token records;
  - the prefix of a scope;
  - the members of `users:all`;
  - `ref:{code}` and `partnercode:{code}` values.

  The two functions must never be swapped: a pointer resolved as a login would break after a move, and a login resolved as an account would bypass the guard (rule 1982).

### 3. Sessions

The session record `{email, at, imp?}` gains `acct`, written by `createSession` from the resolved login.

- **Round 1** (as today): the session record.
- **Round 2**, one parallel round: `login:{login}`, `user:{acct}`, `member:{login}` and `activebrand:{login}`. The session resolves only if the login still maps to `acct` (rule 1984).
- **Round counts:** a session without `acct` (written before release 1) falls back to round 2 = `login:{login}`, `user:{login}`, `member:{login}`, `activebrand:{login}`. That covers every legacy account with no extra round. Only a pre-release-1 session of a moved or opaque account can need a third round, and none exists until release 2. The request cost is one more Redis command per request (`login:`) and no extra round trip.
- **After a move,** the old login's index is gone, so every session of the old address stops resolving even without the `sessionsAfter` stamp. The stamp stays as the second lock.

### 4. Tenant isolation

Nothing in this design takes an id from the request:

- An account id comes from the session (`acct`, checked against the login index), from a stored pointer (above), or from `users:all` in crons.
- The console route `/api/admin/users/[email]` keeps its URL shape. It resolves the address through `getLogin` behind `isAdmin`, and then works with the id.
- No route accepts an account id.

Rule 1980 pins this in the same style as today's scope rules, and rule 1985 adds a source scan: no Redis key template in `src/` interpolates `u.email`, `user.email` or `owner.email`. A short allowlist covers the families that are about an address, not an account: `lock:login:`, `login:`, `verify:code:`, `verify:tries:`, `emailchange:`, `mfa*` and the rate buckets.

### 5. Key families: what follows what

There are three classes. Most families are class A, and class A needs no data change for legacy accounts.

**A. Account-keyed (use `acct(u)` or the scope; never move).**

- *Per scope* (all of it): tasks and their indexes, files and media (`files:`, `file:`, `mfile*`, `mjob:`, `mflight:`), conversations (`convs:`, `conv:`, `chat:`, `fblog:`, `decisions:`).
- *Brand and settings:* `brand:`, `gov*`, `schedule:`, `brief:`, `onboard*`, `skills*`, `skillrefs:`, `profile:`.
- *Connections:* `conn:{s}:{prov}` and `conns:`.
- *Stats:* `sitestats:`, `socialstats:`, `socialpub:`, `xstats:`, `storesales*`, `perfimport:`, `adsync:`, `adstats:`.
- *Routines and holds:* `routine*`, `handoff*`, `ownersync:`, `actskip:`, `activity:`, `brandprop*`, `skillprop*`, `spendprop*`.
- *Secretary:* everything under `SEC_KEYS` (`src/lib/secretary.ts:47-141`), plus `notes:`, `cal-lost:`, `todo-back:` and `meeting:`.
- *Per account:*
  - Records and locks: `user:{id}` (credits, ledger, holds, plan, billing and top-ups are fields of it), `lock:user:`, `brands:`, `brandslock:`, `members:`, `invites:`, `lock:team:`.
  - Notifications and tracking: `notifs:`, `notiflock:`, `notifseen:`, `notified*` (and `notifiedkeys:`), `uev:`, `ufirst*`, `ulast:`, `usage:{id}:…`, `chatm:{id}:trial`.
  - Referral and partner: `referredBy:`, `referrals:`, `referral:*:{ref}`, `shared:`, `partner:`, `partner:refs:`, `partner:ledger:`, `payments:`.
  - MCP and wishlist: `mcptoken-of:`, `mcpgrant:`, `mcpgrants:`, `wish:mine:`.
  - Billing: `paymob:card:`, `paymob:last:`, `paymob:attempt:`.
  - Indexes: the `users:all` members, `founding:seats`, `pricelock:accounts`, `crondone:`/`crontry:` item ids, and `sec:duescopes`/`sec:cal:due` members.

**B. Login-keyed (follow the sign-in address on a move; per-login state).**

- `login:` (new), `member:`, `lock:login:`.
- Sessions and devices: `session:h:` (value), `devs:`, `activebrand:{login}`.
- Two-step: `mfa:`, `mfa:pending:`, `mfaotp:used:`, `mfacode:em:`.
- Address change and proof: `emailchange*`, `verify:code:`, `verify:tries:`.
- Google: `googlesub:` and the `google:{sub}` value.
- Links: `sec:feedof:{login}` and `sec:bookof:{login}:{prov}`, and the `login` field in their records and in the calendar link.
- Rate buckets that name a login (TTL of 1 day at most, so they are ignored).

**C. Values that name the account, where only the pointer's meaning changes (no rewrite for legacy accounts).**

- `member.memberOf`, `invite.owner`, `invite.invitedBy`.
- The `mcptoken:{hash}` value, and `oauthcode`/`oauthrefresh` `email`.
- `paymob:intent:*`/`paymob:txn:*` `email`.
- `ref:{code}`, `partnercode:{code}`, `partner:refs:{p}` members, `referrals:{ref}` rows.
- The `sec:feed:*`/`sec:book:*` `scope`, `skills:feed` rows, `mjobs:open:*` members (`{scope}|{jobId}`).
- The `oauthstate` field named `email` (it holds a scope).

For legacy accounts these already hold the id. New writes hold `acct(u)`. Readers resolve them through `getAccount`.

**Not rewritten: history.** `by` fields on tasks and activity, `sec:audit`, `govhist`, handoff logins, `admin:log` targets, support tickets, `integration-requests`, `deleted-accounts`. They record who acted, under the address of that day. Wording that shows them (for example the activity log) shows what is stored. Decision D3 covers the privacy side.

**Scope parsers.** 17 sites in 10 files take the account out of a scope with `scope.split("#")[0]` or `indexOf("#")`:

- `src/app/api/connect/[provider]/callback/route.ts:59,99,128`
- `src/lib/instructions-store.ts:264`, `src/lib/notifications.ts:72`, `src/lib/origin.ts`, `src/lib/schedule.ts`
- `src/lib/secretary-booking.ts:161`, `src/lib/secretary-gcal.ts:112,206,359`, `src/lib/secretary-remind.ts:59`, `src/lib/secretary-series.ts`
- `src/lib/skills-admin.ts`

The prefix becomes an account id. Each site then uses `getAccount(prefix)` and reads `.email` from the record when it needs an address to mail or compare. They all move to one `accountOfScope(scope)` helper in `brands.ts` (rule 1986). The OAuth callback's check `u.email !== st.email.split("#")[0]` becomes `acct(u) !== accountOfScope(st.email)`.

### 6. The owner move (release 2)

`moveOwnerLogin` is rewritten as a move in place, with no copy and no wipe. It runs under both `lock:login` locks (alphabetical order), then `lock:user:{id}`:

1. Re-check `may(cur)` (the code proved the new address) and the 3-moves-per-UTC-day limit (`emailMoves`).
2. The target is free: `getLogin(to)` is null (index, member, guarded legacy record). Set `login:{to} = {kind:"owner", id}` with `SET NX`. A failed NX is `exists`, unless the stored value already names this id: that is a retry of a stopped move, so continue.
3. Save `user:{id}` with `email: to`, `emailVerifiedAt: now`, a fresh `sessionsAfter` and `emailMoves + 1`.
4. Carry the per-login state from old to new:
   - `mfa:` (as PR #376 does);
   - `activebrand:`;
   - `sec:feedof:` and `sec:bookof:*`, rewriting their records' `login` field. The token URLs are unchanged, so subscribed calendars and Cal.com/Calendly webhooks keep working;
   - the calendar link's `login`.

   The Google link is not carried (PR #376's decision: link it again).
5. Delete the old login's state: `login:{old}`, `devs:` (end every recorded session), `verify:code:`/`verify:tries:`, `emailchange*`, `mfa:{old}`, `activebrand:{old}`, `googlesub:{old}`, and `google:{sub}` when it names the old login.
6. Write the old-address hold and send the notice with the revert link (decision D1, rule 1997).

Notes on the procedure:

- **Not done** (all keyed by the id now): no `wipeAccount`, no `registerCode`/`moveReferral`/`movePartnerRef`, no `deleted-accounts` entry, no change to `users:all`.
- **Crash safety:** the order is new index, then record, then carry, then delete old. Stopping anywhere leaves at most two logins naming the same account (both sign in to the right account), never two accounts and never zero logins. The retry finishes the steps (rule 1988).
- **`ownerHasData` and `owner_has_data`** are deleted in release 2. The page's "changed through support for now" copy goes with them.
- **Members** are unchanged (`moveMemberLogin`). One fix comes with it: delete `googlesub:{old}` and its `google:{sub}`, which PR #376 leaves to a later lookup.
- **The typo fix** (`moveUnverifiedAccount`, rules 763-765) becomes the same move in place in release 2, so there is one move path.

### 7. Paymob

- **The saved card** is `paymob:card:{acct}`. It belongs to the account and does not move. Renewals and the `stopRenewals` lock (rules 1955-1956) key by the id.
- **Intents** gain `acct` and `billingEmail` in release 1, and the old `email` is still written:
  - The webhook resolves the account with `getAccount(intent.acct ?? intent.email)`. That is a stored pointer, never request data.
  - The callback's check that the card's email matches (today `intent.email`, `billing.ts:~291`) compares against `intent.billingEmail ?? intent.email`.

  So a checkout started before an address change still lands on the same account and still saves its card.
- **`billing_data.email`** sent to Paymob (`src/lib/paymob.ts:101`) is `u.email` at the time of the call. After a move, the next renewal sends the new address.
- **Open check** before release 2 (staging, Paymob test mode): a saved-card token charge whose `billing_data.email` differs from the address the card was saved with goes through. If Paymob refuses, the move clears the card under the account lock and the owner adds it again (the plan stays active until the period ends). That is decided by test, not guessed.
- **Old records:** `paymob:txn:*` and old intents keep `email` (400 days). Refund and reconciliation code reads them as account ids through `getAccount`, which is correct for legacy accounts. No data rewrite.

### 8. Composio, MCP and the other external links

- **Composio:** `composioUserId(scope) = HMAC(CONNECT_SECRET, "composio:user:v1:" + scope)[:32]` (`src/lib/connectors/composio.ts:96`, used at `:155`, `:238` and `:257`). An owner move does not change the scope, so the id Composio knows does not change, and connected accounts keep working with no re-link (rule 1992). New accounts get the HMAC of their opaque scope. If "Phase C" ever re-keys legacy accounts, it must keep the old HMAC input per scope (store the seed on the brand), or every connection breaks.
- **MCP and OAuth:** token records point to the account (class C). A personal MCP token keeps working through a move. Grants are keyed by the id.
- **Google and Microsoft calendars, ad and store connections:** keyed by scope (class A). Unaffected.
- **Resend:** no key. Mail goes to `u.email`.

### 9. Crons and anything that iterates accounts

`users:all` members are account ids. For a legacy account that is its first email, exactly what is stored today; for a new one it is `a_…`.

- `dailyRoster`/`allUsers` read `getAccount(member)`, and every cron keys by `acct(u)`/scope. That covers `crondone:{job}:{period}:{scope|id}`, the once-markers (`notified:{id}:…`, so a moved account is never sent day-1 mail again) and `usage:{id}:{month}`. Mail goes to `u.email` (rule 1993).
- The same applies to the other `users:all` readers: admin export and plan, `admin-stats.ts:99`, `evals.ts:150` and `margin.ts:125`.
- `cron/secretary` reads `sec:duescopes`/`sec:cal:due`, whose members are scopes (class A).
- No cron has to change its schedule or batch size. A move is done under the account lock, which `dailyFor` already takes for renewals.

### 10. Account deletion

`wipeAccount(id)` deletes what it deletes today, keyed by the id and its scopes. It also deletes `login:{u.email}` (the current address) and the legacy record key, and never any other account's index (rule 1999). It writes `deleted-accounts` rows as `{id, email, at}`.

Two gaps found while mapping are fixed in the same release:

- added-brand `profile:{id}#brand` keys are not deleted today;
- `deleted-accounts` grows with every typo-fix move. It stops growing once moves no longer wipe.

## Releases (rule 679)

| Step | What ships | Stored shape | Rollback |
|---|---|---|---|
| R1 expand | `acct()`, `getAccount`/`getLogin` split, login index read with the guarded legacy fallback, session `acct`, intent `acct`/`billingEmail`, every key site moved to `acct(u)`/scope, `accountOfScope`. Signup and the typo fix write `login:{e}` and `id = e`. No opaque ids and no owner move with data: a code constant `OPAQUE_IDS = false`, not an environment variable (a variable change needs a rebuild anyway, flows 52 item 10). Production behaviour is identical because every id equals its email. | New: `User.id`, `login:*`, `acct` on sessions and intents. Old code ignores all of them. `GET /api/profile` sends only the fields it names (rule 787), so `id` never leaks to a rolled-back build. | Safe to any earlier build. |
| Script | `scripts/account-ids.mjs`, run after R1 is live and only on the founder's yes (it writes production data). Dry run by default, `--apply` to write. For every member of `users:all`, in parallel chunks of 50 (`pmap`, no `await db.*` in a loop): if `user:{e}` has no `id`, set `id = e`; `SET NX login:{e} {kind:"owner", id:e}`; report (never overwrite) an index that names another id; check every `member:*` on each roster resolves through `getAccount(memberOf)`. A second run writes nothing (rule 1994). It prints totals: accounts, ids set, indexes set, conflicts, orphans. | Same as R1. | Nothing to undo: old code ignores both fields. |
| R2 enable | `OPAQUE_IDS = true`: new signups get `a_…`. The owner move in place (section 6), the old-address hold and revert (D1), the authenticator code for an enrolled login (D2). `ownerHasData` is deleted. **Preconditions:** R1 has been live for 7 days with no fix release touching it, the script reported 0 conflicts and 0 accounts without an index, the rule 1985 source scans in `tests/account-id-r1.test.ts` are clean (security review 2026-10-18: "scan clean"), and the Paymob check of section 7 passed on staging. | Opaque ids and moved accounts (`user:X` holding `email: Y`) now exist. | Back to R1 only: R1 reads both. The release PR says "rollback floor: R1". A build before R1 would sign out every opaque account and, worse, resolve a moved account's old address to its record (the hazard the guard closes), so it is forbidden. **Correction 2026-10-21 (R2 review, fix round 1):** not R1. An R1 build has no L3 guard: a signup or invite at a moved owner's old address writes `user:{old}` again over the moved account. R2 ships as an expand release with the constant off first (branch `claude/wave3a-account-id-r2`, flows 88.2), and the flip PR says "rollback floor: this R2-expand release", which is above R1 and M1. |
| R3 contract | Remove the legacy fallback in `getLogin` (no index means no login) and sessions without `acct`, at least 30 days after R2 (the session TTL). `acct(u)` becomes `u.id` (required on `User`). Readers of `intent.email` and `txn.email` as an account stay until the 400-day TTL lapses, then go in a later contract. | None. | Back to R2. |
| Phase C (not planned) | Re-key legacy accounts from the email-shaped id to `a_…` so no address stays in a key name. Per account, offline: pause its crons, `RENAME` every key of the account's families (Upstash keeps the TTL and type), keep the Composio seed, and rewrite the class C pointers. Only if decision D3 says the address in key names must go. | Every key of the account. | Needs its own spec. |

## Size and risk

- **R1 is large.**
  - About 440 uses of `u.email` / `user.email` / `owner.email` in about 130 of the 722 source files have to be read and sorted into key (becomes `acct(u)`) or address (stays). The estimate is 150-200 become `acct(u)`, plus 80 key templates that interpolate an email directly (49 files).
  - On top of that: the 17 scope parsers, about 25 value readers (class C), `resolveSession`, `getLogin`, `createUser`, `saveUser`, `wipeAccount`, `startCheckout` and the webhook.
  - The diff is about 1.5k-2.5k lines across about 140 files.
  - The risk in production is low by construction, because id equals email for every account, so a missed site behaves exactly as today. The risk is that a missed site only shows once ids differ. Two mitigations, both in R1:
    1. The test helper `newUser` (`tests/helpers/session.ts`) creates accounts with `id: "a_…"` (`OPAQUE_IDS` forced on in tests), so all ~7,900 existing tests run with id ≠ email and any site still keyed by email fails a round trip.
    2. The source scan of rule 1985.
- **The script is small** (about 150 lines). Its risk is low: two `SET NX`-style writes per account, idempotent, dry run first.
- **R2 is medium** (about 400 lines). Its risk is medium, concentrated in the move procedure and the guard; rules 1981, 1987-1990 pin them.
- **R3 is small.**
- **Redis cost:** one more command per request (`login:`), no new round trip (section 3). The script costs about 3 commands per account, once.
- **Order with other work:** R1 touches almost every API route, so it must not run beside a wide refactor. The API route wrapper conversion (PR #374 and its remaining batches) is the obvious collision. Land R1 between wrapper batches, not during one.

## Decisions (coordinator defaults; the founder can overturn)

- **D1. Old address after a move.** Default: hold it for 30 days (`emailhold:{old} = {id, until}`). During the hold it cannot sign up or be taken by another move. The notice to the old address carries a single-use revert link valid for 7 days. The link puts the old address back, ends every session, turns off the new login's two-step if it was set up after the move, and sends a password reset. This answers "someone with my password moved my account". Alternative: no hold, notice only (today's #376 behaviour).
- **D2. Two-step during a change.** Default: a login with two-step sign-in on must also give an authenticator or recovery code to start an address change (PR #376 asks only for the password).
- **D3. The old address inside key names.** Default: accept it for legacy accounts. Keys are never shown and are deleted with the account, and Phase C waits until a reason appears (a privacy request, a data-protection review). Alternative: plan Phase C now.
- **D4. Google link on a move.** Default: not carried (PR #376). The person links again.
- **D5. Precondition window for R2.** Default: 7 days of R1 live.

## Test rules to pin (1980-1999)

- **1980.** Account ids come only from the session (`acct` checked against the index), a stored pointer or `users:all`. No route takes one from the request. A new id matches `^a_[a-z2-7]{24}$` and comes from `crypto`.
- **1981.** The legacy fallback in `getLogin` accepts `user:{e}` only when the record's own `email` is `e` (and `id` is unset or `e`). A moved account's old address resolves to nothing, forgot-password on it sends nothing, and a signup with it makes a separate account that never reads or writes `user:{old}`.
- **1982.** Pointers (`memberOf`, invite owner, MCP token, OAuth code and refresh, Paymob intent and txn, feed and booking records, scope prefix, `users:all`) resolve through `getAccount`. Logins resolve through `getLogin`. A source scan pins which functions call which.
- **1983.** `login:{e}` is written with `SET NX` under `lock:login:{e}`. Two parallel signups or moves to one address give exactly one owner.
- **1984.** A session resolves only when its login still maps to its `acct`. A pre-R1 session (no `acct`) of a legacy account resolves in the same number of rounds as today.
- **1985.** Every test account has an opaque id. A source scan finds no Redis key template in `src/` interpolating `u.email`, `user.email` or `owner.email` outside the address allowlist.
- **1986.** `accountOfScope` is the only scope parser. The 17 former sites mail and compare with the record's `email`.
- **1987.** Round trip: an owner whose account has every class A family populated, with members, a card, a Composio connection, an MCP token, a referral, partner data and Reem items, moves from X to Y. Every read is unchanged afterwards, and sign-in with Y opens it.
- **1988.** Stopping the move after each step and retrying ends in one account with one login (Y), never two accounts and never none.
- **1989.** After the move: X signs nothing in, every old session and device is dead, and a member's `memberOf` still resolves.
- **1990.** Two-step, the active brand, the feed and the booking links follow the login. The token URLs are unchanged and keep answering.
- **1991.** A Paymob webhook for an intent made before a move applies to the same account. The callback email check uses `billingEmail`. A renewal after the move sends the new address and charges the same card.
- **1992.** `composioUserId` is the same before and after a move.
- **1993.** The crons key by id. A moved account's lifecycle and brief mail goes to the new address, and once-markers are not sent again.
- **1994.** The conversion script is idempotent, dry run by default, reports conflicts without overwriting, and makes no `await db.*` inside a loop.
- **1995.** R1 writes only shapes older builds ignore (`id`, `login:*`, `acct`), and `GET /api/profile` does not send `id`.
- **1996.** With `OPAQUE_IDS` off, signup writes `id = email`. With it on, signup writes `a_…`. Owner moves with data are refused while it is off.
- **1997.** The old-address hold and the revert link work as in D1 (single use, 7 days, ends sessions, resets the password).
- **1998.** An address change by a login with two-step on needs a code (D2).
- **1999.** `wipeAccount(id)` deletes the current login index and the legacy record and never another account's index. Added-brand `profile:` keys are deleted.

`docs/system/tests/1980-account-id.md` lists them when built (rule 788).

## Docs to update when built

- `docs/system/architecture.md`:
  - section 3, the key namespace: add `login:` and `emailhold:`, and say that account keys use the id;
  - section 4(f), resolving who is acting.
- `docs/system/flows.md`:
  - section 5, sessions: the `acct` field and the new round 2;
  - section 53 items 8-9: the typo fix becomes the move in place;
  - section 80.3: the limit is lifted;
  - section 52 item 9: a worked case for this change's rollback floor.
- `docs/system/permissions.md`:
  - 0, Actors: the account is `user:{id}`;
  - 3.1, how a scope is derived: from the account id;
  - 3.2: the console's `[email]` lookup through `getLogin`.
- `docs/system/variables.md`: no change. No new variable; `OPAQUE_IDS` is a code constant.

## Findings for PR #376 now (independent of this spec)

1. **Data loss.** `ownerHasData` does not look at the secretary's items (`sec:*`), `skills:`, `gov:`, `schedule:`, `profile:`, `activity:`, `decisions:`, `handoffs:` or `notes:`. A trial owner who has used only Reem or agent instructions passes the check, and `wipeAccount(old)` deletes those items on the move. Fix in #376: refuse when any of them exists. The cheapest checks are `sec:all:{e}` (or the secretary's open index), `skills:{e}`, `gov:{e}` and `activity:{e}`, all in the same one round. Do not refuse on a key the system writes by itself on an empty account; the daily cron's `schedule:` write (`lastDaily`) is one. Pin it in rule 1944's test.
2. **Stale link.** `moveMemberLogin` leaves `googlesub:{old}` and the `google:{sub}` that names the old login. It is cleaned on the next Google lookup, but it should be deleted in the move.
3. **Missed keys on wipe.** `wipeAccount` deletes only `profile:{e}`. Added-brand `profile:{e}#{id}` keys survive the deletion of an account.

## Applied in R1 (2026-10-18, branch `claude/wave3-account-id-r1`)

Built as the expand step with the multi-org spec's forced changes (`docs/specs/2026-10-18-multi-org.md`): the login index is `{kind:"person", pid}` (the first shape `{kind:"owner", id}` is still read), members store a frozen `id`, and the session's `acct` is the active workspace. Where the build differs from the text above:

- The script is `scripts/account-ids.ts`, run with `npx --no-install jiti scripts/account-ids.ts [--apply]` like `scripts/media-blob-move.ts`, so the test imports it. It also gives members their `id` and index.
- `claimLogin` writes the index with a plain `SET` under `lock:login:{e}` after `getLogin` found nothing, not `SET NX`: `db.setNx` needs a TTL, and the lock already serialises writers. That also replaces an index a rolled-back build left without an account.
- Rule 1985's "every test account has an opaque id" is met by opt-in opaque tests (`newOpaqueUser`, `createUser(input, { opaque: true })`) plus the source scans; switching every fixture waits for R2, when `OPAQUE_IDS` turns on.
- The owner move is still a copy in R1: the new record is saved with `id = to` at `user:{to}`, so its key is its id. The move in place is R2.
- The founder console's user page resolves the address in its URL through `getLogin` and acts on `acct(u)`.
- The coverage list is `docs/system/tests/1980-account-id-r1.md`; flows.md section 88.
- Security review of R1 (2026-10-18, M1, M2, L1 fixed before the PR was marked ready; flows.md section 88 item 9). R2 must start with the widened rule 1985 scan clean. Left for R2, listed so they are not missed: `listPartners` and the partner views read `user:{referred}` by the value in the referral set (an id from R1 on, the same bytes until R2); referral rows keep the id in a field named `email`; `forgetWishlistUser` is called with the account's address; L2 (the script's `claimIfAbsent` does not re-check the record under the lock, harmless), L3 (`getLogin` treats `user:{e}` holding another address as free, only hand-edited data, which the script reports), L4 (the founder's user page hides an owner that fails `ownsLogin`).
