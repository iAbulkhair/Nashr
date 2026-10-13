# Staff identity: a console sign-in separate from customer accounts

Status: decided by the coordinator on 2026-10-13 (the founder can overturn), not built. Written 2026-10-13 against `main` at `28e784d5`. Two phases: phase 1 needs no founder setup; phase 2 needs founder setup and comes later. Rules reserved: 1630-1659 (checked free on 2026-10-13: no hit for `\b16[3-5][0-9]\b` under `docs/` or `tests/` on `origin/main`, no open pull request, no local branch using them). Permission-row numbers and the flows section number are assigned by the coordinator when it is built.

## ملخص للمؤسس

- اليوم: لوحة المؤسس تفتح بحسابك العادي كعميل (بريدك في `ADMIN_EMAILS`) أو بمفتاح اللوحة. أي سرقة لجلسة حسابك كعميل تعني دخول اللوحة.
- القرار: حساب «موظف» منفصل تماماً عن حسابات العملاء، بصفحة دخول خاصة داخل اللوحة: بريد + كلمة مرور + رمز من تطبيق المصادقة (إلزامي)، وجلسة قصيرة (15 دقيقة خمول، 12 ساعة حد أقصى) بملف تعريف (كوكي) خاص بها.
- أول حساب موظف تنشئه أنت بنفسك مرة واحدة: تدخل بمفتاح اللوحة (والرمز إن كان مفعّلاً)، تكتب بريدك، فيظهر لك رمز إعداد مرة واحدة تكمل به. لا سر في المحادثة ولا متغير جديد.
- نسيان كلمة المرور لا يعتمد على البريد: رموز استرداد تحفظها، ومفتاح اللوحة كباب طوارئ. السبب: من يسرق بريدك لا يصل للوحة.
- المرحلة الأولى تبقي الدخول القديم يعمل مع شريط تنبيه، وبعد أن تدخل بحساب الموظف تغلق الباب القديم بزر، ثم يُحذف من الكود في إصدار لاحق.
- المرحلة الثانية (لاحقاً، تحتاج منك إعداداً): الدخول بحساب Google الخاص بنطاق الشركة، ومفاتيح المرور (passkeys)، ونطاق منفصل admin.thakeen.com.

## Goal

The founder console is reached only through a staff identity that is a different record type from any customer account, with a mandatory second factor, its own short session and its own cookie. Stealing or riding a customer session (including the founder's own customer account) never opens the console.

## Today (read on `origin/main` 28e784d5)

- `adminActor(req)` (`src/lib/auth.ts`) answers, in order: `"key"` for the `x-admin-key` header (`sameSecret`, 30 tries per IP per 15 min), `"key"` for a live key session (`nashr_admin` cookie, random id, record `adminsession:{sha256(id)}` holding a fingerprint of `WAITLIST_ADMIN_KEY`, 15 minutes idle and 12 hours absolute), else the founder's email when `isFounderActor(currentUser())`: a normal customer session whose owner email is in `ADMIN_EMAILS`.
- `isAdminCookie()` / `requireAdmin()` (`src/lib/admin-gate-server.ts`) gate the `/{lang}/admin` pages the same way; signed-out visitors get a 404 (rule 870), the key form shows at `/{lang}/admin?login=1`.
- The key form (`POST /api/admin/login`) takes the key alone (5 tries per IP per 15 min).
- Second factor (rules 1370-1384, flows 64, `src/lib/admin-2fa.ts`): ONE console-wide enrolment `admin:2fa`, optional, not yet enrolled; once enrolled every founder write needs a step-up (`nashr_admin_2fa`, 30 idle minutes, 12 hours) or `x-admin-otp`. Reads never ask. The step-up is tied to the actor and to the cookie that made them the actor (`nashr_admin` or `nashr_session`).
- Cookies are `httpOnly`, `SameSite=Lax`, Secure by transport (`sessionCookie`), no `__Host-` prefix.
- `ADMIN_EMAILS` also names the recipients of the golden-set alerts and the margin bell (`golden.ts`, `margin.ts`).
- Audit: `adminAudit` writes `admin:log` with `actor` = the founder's email or `"key"`.
- Another branch (`claude/admin-2fa-qr`, rules 1620-1624) adds a QR code to the TOTP setup. This spec does not touch those files; the build starts after it merges and reuses its QR component.

## Threat model

| Threat | Today | Phase 1 | Phase 2 |
|---|---|---|---|
| Customer session theft (stolen `nashr_session` cookie, a session left open on a shared device, a token in a log) reaches the console | Yes: the founder's customer session IS a console session, and reads never ask for the second factor | Closed once the customer path is switched off (rule 1650): a customer session is never a console actor | Closed |
| Shared identity: one account is both a customer (testing, connectors, agents reading untrusted content) and the console owner; a bug or an account takeover on the customer side carries console power | Yes | Closed: `staff:{email}` is a separate record; the same address may exist as a customer but the two never share a password (rule 1641), a session, a cookie or a reset path | Closed |
| Customer-side XSS on thakeen.com making requests to `/api/admin/*` with the staff cookie attached | Yes | NOT closed: the console and the customer app share one origin, and a script running on that origin can send same-origin requests that carry any cookie, `SameSite=Strict` and `HttpOnly` included. Reduced: writes still need a step-up, and staff sessions are short. Said plainly so nobody counts on it | Closed by a separate host (`admin.thakeen.com`) with a host-only cookie and an Origin pin on every console write (rules 1657-1658) |
| Cross-site request forgery against console writes | Lax cookie; JSON bodies | `SameSite=Strict` staff cookie plus an Origin / `Sec-Fetch-Site` check and JSON-only bodies on console writes (rule 1647) | Same, pinned to the admin origin |
| Password reuse (the founder uses the same password as on his customer account or elsewhere) | The customer password protects the console | Refused when equal to the customer account password of the same address (rule 1641); a mandatory authenticator code means a reused password alone opens nothing | Google Workspace sign-in or a passkey replaces the password |
| Phishing (a fake console page relays password and code in real time) | Not addressed | Not closed: a password plus a 6-digit code can be relayed. Reduced: short sessions, writes ask again, staff management asks for a fresh code | Closed for staff who use a passkey: WebAuthn binds the credential to the real origin, so a look-alike site gets nothing usable |
| Brute force on the sign-in | Key form 5 per IP per 15 min | Per IP and per address limits, a short lock per address, failures counted outside `admin:log` so they cannot push real audit rows out (rule 1644) | Same |
| Email account takeover used to reset access | The customer "forgot password" resets the founder's customer account, which is the console | No email path for staff at all (rule 1643) | Same; Google sign-in depends on the Workspace account, which has its own 2-step policy |
| Lost phone and lost recovery codes | Delete `admin:2fa` in Upstash | Break-glass: the console key plus the console code issue a single-use reset (rules 1643, 1645) | Same |
| AI agents or MCP tokens acting as staff | No path (the console accepts cookies and the key only) | Unchanged and pinned: no MCP token, OAuth grant or agent tool is ever a staff actor (rule 1653) | Same |

## How large platforms separate staff from customers (general knowledge)

From general public knowledge of these products, not verified against their current documentation on 2026-10-13, and with no numbers or quotes:

- Google Workspace: the admin console lives on its own host (`admin.google.com`), and Google's published advice for super administrators is to keep a separate account used only for administration, with strong 2-step verification such as security keys.
- Microsoft Entra / Microsoft 365: guidance for privileged roles is dedicated administrator accounts separate from daily accounts, plus a small number of "emergency access" (break-glass) accounts kept for when normal sign-in fails.
- Shopify: a store's staff accounts are a different thing from the store's customer accounts, are managed with per-staff permissions, and sign in to the admin on its own host (`admin.shopify.com`).
- Stripe: the dashboard has named roles (for example administrator, developer, analyst, view only) so a person gets only what the job needs.
- GitHub: "sudo mode" asks for authentication again before sensitive actions even inside a live session, and supports passkeys and security keys as phishing-resistant factors.

The common pattern this spec adopts: (1) admin identity separate from the daily/customer identity; (2) admin console on its own host and cookie scope (phase 2); (3) mandatory second factor, moving to phishing-resistant passkeys; (4) re-authentication before sensitive actions; (5) roles with least privilege; (6) company single sign-on for staff, restricted to the company domain (phase 2); (7) audit rows that name the human; (8) a break-glass path that is rare, strong and logged.

## Phase 1 (no founder setup)

### Data shapes (rule 679: new keys only; customer shapes gain only optional fields)

```ts
type StaffRole = "owner" | "support";           // only "owner" can be created in phase 1
type Staff = {
  email: string;                 // normalized; the record lives at staff:{email}
  name: string;
  role: StaffRole;
  passHash: string;              // bcrypt, cost 12; "" until the setup code is redeemed
  totp?: { enc: string; kid: string; at: string }; // sealed secret; absent until enrolled
  rc?: string[];                 // SHA-256 of the unused recovery codes (8 issued at enrolment)
  createdAt: string; createdBy: string;            // "key" (bootstrap) or a staff email
  disabled?: boolean;
  sessionsAfter?: string;        // ISO: sessions and step-ups issued before are void
  lastSignInAt?: string;
};
```

| Key | Holds | TTL |
|---|---|---|
| `staff:{email}` | `Staff` | none |
| `staff:index` | set of staff emails | none |
| `staff:config` | `{ customerPathOff?: { at, by } }` (rule 1650) | none |
| `staffsession:{sha256(id)}` | `{ email, at, seen }` | idle window, cut at 12 h |
| `staffpre:{sha256(id)}` | `{ email, stage: "code" \| "enrol", at }` between password and code | 5 min |
| `staffenrol:{sha256(email)}` | pending sealed secret | 15 min |
| `staffotp:used:{sha256(email)}:{step}` | burned 30-second step | 120 s |
| `staffsetup:{sha256(code)}` | `{ email, by, at, kind: "setup" \| "reset" }`, single use | 30 min |
| `stafffail:{sha256(email)}` | failure counter for the lock | 15 min |
| `admin2fa:step:*` | the existing step-up record; for a staff actor its `base` is the staff session cookie | as today |

- The TOTP secret is sealed with AES-256-GCM under a key derived from `CONNECT_SECRET` with its own label (`nashr-staff-totp:`), and carries `kid` so a record sealed before a `CONNECT_SECRET` rotation still opens with `CONNECT_SECRET_PREVIOUS` (the connector store's approach, rule 1351) and is resealed at the next sign-in. Without this a rotation would lock every staff member out (rule 1654).
- Request-derived lookups: only the sign-in (`staff:{email}` from the typed address, normalized and `validEmail`-checked, exactly as `POST /api/auth/login` reads `user:{email}`) and the owner's staff-management routes (target address from the body, like today's `/api/admin/*` customer targets). Every other key comes from the server session.
- The customer `Session` gains one optional field, `ss` (rule 1648); old code ignores it. The audit row gains one optional field, `via` (`"staff" | "key" | "header" | "founder-session"`); old readers ignore it. Nothing else in customer shapes changes.

### Sign-in (rules 1631-1634)

1. `/{lang}/admin/login`: email and password. `POST /api/admin/staff/login` answers one generic refusal for an unknown address, a wrong password, a disabled record or a locked address, and runs a bcrypt compare against a fixed dummy hash when the address is unknown, so timing does not tell staff addresses apart. On success it sets the pre-auth cookie (`__Host-thakeen_staff_pre`, 5 min) and answers `next: "code"` or, with no authenticator yet, `next: "enrol"`.
2. Code: `POST /api/admin/staff/login/code` takes the 6 digits (step burned, as rules 1370-1384) or a recovery code. A recovery code is spent, and the person must enrol a new authenticator before a session opens (rule 1642).
3. Enrol (first sign-in, or after a recovery code or a reset): `POST /api/admin/staff/login/enrol` `start` returns the secret and the `otpauth://` URI, which the QR component from `claude/admin-2fa-qr` renders; `confirm` checks a code from it, stores the sealed secret, returns 8 recovery codes once («احفظ رموز الاسترداد الآن» / "Save your recovery codes now"), and opens the session.
4. Session: `staffsession:{sha256(id)}` behind `__Host-thakeen_staff` = a random 32-byte id. `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`. Idle 15 minutes, absolute 12 hours, renewed at most once a minute with `SET XX`, both limits also checked in code: the same logic as today's key session (reuse it, do not copy it). On plain http to the loopback host only (local development) the cookie is named `thakeen_staff_dev` without the prefix, because browsers refuse a `__Host-` cookie without `Secure`; this mirrors the loopback exception `sessionCookie` already makes.
5. Sign-in counts as a step-up (it has just checked a code): it opens the existing step-up record tied to the staff session. Later writes follow today's step-up rules (30 idle minutes, 12 hours).
6. Sign out: `DELETE /api/admin/staff/login` deletes the record and both cookies.
7. `SameSite=Strict` means a link to the console opened from email or chat arrives without the cookie. Console pages with no live staff or key session therefore redirect to `/{lang}/admin/login?next=…` (through `safeNext`) instead of the 404 of rule 870 (rule 1652). The sign-in page is public anyway (as `?login=1` is today), so the 404 no longer hides anything, and the next same-site navigation from the sign-in page carries the cookie.

### Second factor, re-authentication and roles (rules 1632, 1636, 1637)

- TOTP is mandatory for staff: no staff session opens without a code, and there is no "skip".
- `adminActor(req)` keeps its signature (a string, so the 30-odd callers do not change) and records the details for the request in a `WeakMap<Request, { who, via, role }>`; `secondFactorRefusal(req, who)` reads them. For a staff actor the code is checked against that person's own secret, and the step-up `base` is the staff session cookie.
- The role check lives in the write gate every founder write already calls (`secondFactorRefusal`): a staff actor whose role is not `owner` gets 403 `read_only`. It fails closed for any unknown role. `support` (read-only) is created only in a later step; phase 1 accepts `owner` only at creation.
- Staff management (create, disable, enable, reset, role change), the customer-path switch, and changing one's own password or recovery codes need a FRESH code in the request (`x-admin-otp` or the prompt), never a live step-up: the "sudo" pattern for the actions that change who can get in.

### First staff account: bootstrap (rule 1639)

Chosen option: the founder bootstraps from a key session.

1. The founder opens the key form (`/{lang}/admin?login=1`), types the console key and, when `admin:2fa` is enrolled, its code (rule 1645).
2. While no `owner` staff record exists, the console shows «إنشاء حساب الموظف» / "Create your staff login". `POST /api/admin/staff/bootstrap` takes an email, a name and a reason, writes `staff:{email}` (role `owner`, empty password), logs `staff.bootstrap` (actor `"key"`), and answers a setup code ONCE on screen, valid 30 minutes, single use.
3. The founder opens `/{lang}/admin/login/setup`, types the email, the setup code and a new password, and is taken to the enrol step. The code is typed into a form, never put in a URL (secrets are never accepted in URLs).
4. Once an `owner` exists the bootstrap route answers 409 `exists` for everyone, key included.

Why this option: it needs no new environment variable, no secret pasted in chat and no email, and it gives the key holder nothing the key does not already give (the key opens the whole console today). The alternatives are weaker: a setup token in an environment variable adds a secret to handle and to forget to remove; bootstrapping from the founder's customer session would rest the new identity on exactly the session we are moving away from; a setup token written to the server log breaks the rule that secrets are never logged. If `admin:2fa` is not enrolled when he bootstraps, the bootstrap rests on the key alone, which is today's level; the console banner recommends enrolling the console code first, and the key form then needs it.

### Adding staff, password reset, recovery (rules 1640-1644)

- Add a staff member: an owner with a fresh code creates the record and gets a setup code shown once, handed over in person; the new person redeems it as in bootstrap step 3. Phase 1 creates `owner` only.
- Password policy: 12 to 128 characters; refused when it equals the customer account password of the same address (one bcrypt compare against `user:{email}` when such a customer exists) and when it is on a short built-in list of common passwords; bcrypt cost 12. No composition rules.
- Recovery codes: 8 single-use codes at enrolment, stored as SHA-256, shown once, regenerable by the person with a fresh code. Spending one requires the password first, then forces a new authenticator.
- Lost password: an owner (or, when nobody else can, the break-glass key session with the console code) issues a reset setup code (single use, 30 minutes), and the person sets a new password and enrols again. A reset sets `sessionsAfter`, so every session and step-up of that person ends.
- No email in any staff recovery path. Why: the main attack on a founder is phishing or taking over his mailbox, and an email reset would turn the mailbox into the console's weakest door; transactional email is also a dependency (deliverability, a provider outage) that a recovery path must not have. Admin recovery for privileged accounts on large platforms generally goes through another administrator or a break-glass account rather than a mailed link.
- Lock: 10 failed sign-ins for one address in 15 minutes lock that address for 15 minutes (the break-glass key path is not affected, so a lock can never shut the founder out); 5 tries per IP per 15 minutes, as on the key form. Failed attempts are counted in `stafffail:*`, not written to `admin:log` one by one, because `admin:log` keeps the last 5,000 rows and a flood of failures must not push real audit rows out; one `staff.locked` row is written per lock.

### Break-glass and scripts (rules 1645, 1646)

- The browser key form stays, as break-glass only. Once `admin:2fa` is enrolled it needs the key AND a console code in the same submit (or the recovery code, which, as today, removes the enrolment). Every key-form sign-in writes `key.login`. A key session shows a banner «جلسة طوارئ بالمفتاح، ادخل بحساب الموظف» / "Break-glass key session: sign in with your staff login".
- `x-admin-key` stays for scripts and cron-like calls, rate limited as today; writes need `x-admin-otp` once `admin:2fa` is enrolled, as today. A header call never opens a browser session.
- `admin:2fa` stays the console key's second factor. Each staff member has their own authenticator. The two are separate on purpose: the key is the emergency door, staff logins are the daily door.

### Impersonation from a staff session (rule 1648)

Viewing a customer account from a staff session works as today, with `imp` = the staff email and the new optional `ss` = the staff session record's hash. `resolveSession` ends the customer view when that staff session is no longer live, and a request through the view renews it (as `keyImpLive` does for the key). Ending the staff session ends the view.

### Audit (rule 1638)

`actor` = the staff email (or `"key"`), new optional `via`. Events: `staff.bootstrap`, `staff.create`, `staff.disable`, `staff.enable`, `staff.reset`, `staff.role`, `staff.signin`, `staff.locked`, `staff.enrol`, `staff.recovery`, `staff.password`, `staff.signout`, `key.login`, `console.customerPathOff`. Secrets (password, codes, setup codes, the TOTP secret) never enter a row; `adminAudit`'s redaction already drops secret-named keys.

### Expand and contract (rule 679; rules 1649-1651)

- Expand release (the release pull request names the step "expand"): everything above ships. The `ADMIN_EMAILS` customer-session path still opens the console, but every console page reached that way shows «انقل دخولك إلى حساب الموظف» / "Move to your staff login" with a button to the bootstrap or sign-in page, and its audit rows carry `via: "founder-session"`. Old code still running during a deploy never reads the new keys and ignores `ss` and `via` safely.
- Closing the old door without waiting for a release (rule 1650): an owner signed in through a staff session, with a fresh code, can set `staff:config.customerPathOff`. From then on `adminActor` and `isAdminCookie` ignore customer sessions. The switch is refused unless the caller is a staff owner with an enrolled authenticator, so it cannot lock the founder out, and the key path is still there.
- Contract release (step "contract", later, after the founder has signed in with his staff login and closed the door): the code of the customer-session path is removed (`isFounderActor` no longer gates the console, the customer sidebar's console link goes, the switch's reading goes). `ADMIN_EMAILS` stays, narrowed to "who receives founder alerts" (golden set, margin bell); `docs/system/variables.md` says so.

### Routes (phase 1)

Pages under `src/app/[lang]/admin`: `login` (email and password, code, enrol), `login/setup` (setup or reset code), `staff` (owner: list, add, disable, reset), `account` (own password, recovery codes, sign out). All `noindex` and `Cache-Control: no-store`; every word in Arabic and English.

| Method | Path | Who | Gate |
|---|---|---|---|
| POST | `/api/admin/staff/login` | public | rate limit per IP and per address, lock, generic refusal |
| DELETE | `/api/admin/staff/login` | staff session | ends its own session |
| POST | `/api/admin/staff/login/code` | pre-auth cookie | code tries as rules 1370-1384, step burned |
| POST | `/api/admin/staff/login/enrol` | pre-auth cookie at stage `enrol` | code tries limit |
| POST | `/api/admin/staff/setup` | public, with a setup code | rate limit per IP; code single use |
| POST | `/api/admin/staff/bootstrap` | key session (plus the console code when enrolled) | 409 once an owner exists; reason required |
| GET | `/api/admin/staff` | staff owner | `adminActor`, role |
| POST | `/api/admin/staff` | staff owner | `adminActor`, fresh code, reason (`reasonRefused`), `adminAudit` |
| POST | `/api/admin/staff/me` | staff session | fresh code for password and recovery codes |
| POST | `/api/admin/staff/config` | staff owner | fresh code, reason; refused for key and founder-session actors |
| POST | `/api/admin/login` (changed) | key form | key plus the console code once `admin:2fa` is enrolled |

Every console write also passes the Origin check of rule 1647: a request whose `Origin` is not this site's own, or with `Sec-Fetch-Site: cross-site`, is refused 403 before anything else, and bodies must be JSON.

### Permission rows to add or change (`docs/system/permissions.md`)

- Section 0: a new actor row "Staff (console)": cookie `__Host-thakeen_staff` to `staffsession:{sha256(id)}` to `staff:{email}`; never a customer `User`; resolved by `adminActor`.
- Section 0, "Founder admin" row: the key form needs the console code once enrolled; the founder customer-session path marked "expand only, closable by rule 1650, removed at contract".
- Section 1.7: a new row for each route in the table above; rows 75 and 76 changed for the key form.
- Section 2.1: the four new pages; the 404 for signed-out visitors replaced by the redirect (rule 1652).
- Section 4: items 1-4 and 6-7 rewritten (founder customer accounts are no longer a console identity; a suspended customer founder no longer matters to the console; item 6's "signup has no email verification" is out of date since rule 751 and is corrected in the same edit); item 10 (`via`); item 10a (the staff step-up and the role check).

### Flows section to add (`docs/system/flows.md`)

"Staff identity: sign-in, enrolment, recovery, bootstrap, break-glass", covering: bootstrap (key session, setup code), daily sign-in (password, code), first sign-in enrolment (QR, recovery codes), a lost phone (recovery code, then enrol), a lost password (owner or break-glass reset code), a locked address, the break-glass key form, closing the customer path, the contract release, and what a `CONNECT_SECRET` rotation does.

### Environment variables

Phase 1 adds none. It uses `CONNECT_SECRET` and `CONNECT_SECRET_PREVIOUS` (sealing staff secrets), `WAITLIST_ADMIN_KEY` (break-glass and scripts) and `ADMIN_EMAILS` (the expand-only console path, and alert recipients for good). `variables.md` notes the changed meaning of each.

### Rules (1630-1659)

| Rule | Statement |
|---|---|
| 1630 | Staff are `staff:{email}` records, never a customer `User`; a customer session is never a staff actor. |
| 1631 | Staff sign-in: one generic refusal, dummy-hash timing for unknown addresses, rate limits per IP and per address. A password alone never enrols an authenticator: a record without one signs in only through a setup or reset code (security review 2026-10-13, L2). |
| 1632 | No staff session without an authenticator code; the first sign-in must enrol, and only after a setup or reset code; no skip. |
| 1633 | Staff cookie `__Host-thakeen_staff`: random id, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`; a dev name on loopback http only. |
| 1634 | Staff session record under a hash of the id; 15 min idle, 12 h absolute, renewed at most once a minute with `SET XX`; sign-out deletes it. |
| 1635 | `sessionsAfter` ends every session and step-up of a staff member at password reset, authenticator reset, disable and role change. |
| 1636 | Staff writes need a step-up tied to the staff session; staff management, the customer-path switch and own credential changes need a fresh code. |
| 1637 | A role on every staff record; any role other than `owner` cannot write (403 `read_only`), unknown roles fail closed; phase 1 creates `owner` only. |
| 1638 | Audit rows name the staff email and carry `via`; the listed events are written; no secret in any row. |
| 1639 | Bootstrap only from a key session (plus the console code when enrolled), only while no owner exists; the setup code is shown once, single use, 30 minutes. |
| 1640 | New staff only by an owner with a fresh code, through a single-use setup code typed into a form, never in a URL. |
| 1641 | Staff password 12 characters to 72 UTF-8 bytes (bcrypt reads no further; a longer password is refused with `password_long`, and a typed value over 72 bytes never matches), not on the common list, not equal to the customer password of the same address; bcrypt cost 12. |
| 1642 | 8 single-use recovery codes stored hashed; spending one needs the password and forces a new authenticator. |
| 1643 | No email to the staff member in any recovery path; a lost password goes through an owner or the break-glass key session. A reset clears the password, the authenticator and the recovery codes at once and ends every session, inside the record's lock, before the code is shown; nobody resets their own login. The key session resets or enables a login only when `admin:2fa` is enrolled AND a fresh console code comes with the request (`console_code_required`), and only while no other active owner exists (`owner_active`); every such reset or enable mails every `ADMIN_EMAILS` address (action, login and time only, never a code or the reason; skipped when mail is not set up). |
| 1644 | 10 failures per address in 15 minutes lock it for 15 minutes; failures are counted outside `admin:log`; one `staff.locked` row per lock, written after the answer. The lock blocks password-only attempts: the right password together with a right authenticator code in the same request still signs in (code tries limited per address and per IP), and any wrong part is the same 401. The own-password check (`staff/me`) is refused while locked, counts toward the lock, and has its own IP limit. |
| 1645 | The browser key form needs a console code once `admin:2fa` is enrolled; every key sign-in is logged; break-glass banner. |
| 1646 | `x-admin-key` stays for scripts, rate limited, with `x-admin-otp` for writes once enrolled; it never opens a browser session. |
| 1647 | Console writes refuse a foreign `Origin` or `Sec-Fetch-Site: cross-site`, and non-JSON bodies; this includes every `/api/admin/2fa` action and marking leads seen. A script on the `x-admin-key` header (no cookie) skips the `Origin` and JSON parts, never the `Sec-Fetch-Site: cross-site` refusal. |
| 1648 | A customer view opened from a staff session carries `ss` and ends with that staff session. |
| 1649 | Expand: the `ADMIN_EMAILS` customer-session path still works, with a banner and `via: "founder-session"`. |
| 1650 | A staff owner with a fresh code can switch the customer-session path off at runtime; refused for key and customer actors. |
| 1651 | Contract: the customer-session path is removed from the code; `ADMIN_EMAILS` names alert recipients only. |
| 1652 | Console pages with no live staff or key session redirect to the sign-in page (replaces the 404 of rule 870). |
| 1653 | Staff pages and routes are `noindex` and `no-store`; no MCP token, OAuth grant or agent tool is ever a staff actor. |
| 1654 | Staff TOTP secrets are sealed under a `CONNECT_SECRET`-derived key with their own label and a `kid`; the previous key still opens them after a rotation. |
| 1655 | Phase 2: Google sign-in for staff only with a verified ID token whose `hd` and email domain equal the company domain and `email_verified` is true, AND an existing staff record; Google proves who, the staff record decides whether. |
| 1656 | Phase 2: passkeys (WebAuthn) as a staff factor, relying party = the admin host; a passkey replaces the authenticator code at sign-in. |
| 1657 | Phase 2: the console answers only on `ADMIN_ORIGIN`; its cookies are host-only there; console writes pin `Origin` to it. |
| 1658 | Phase 2: once the admin host is live, `/{lang}/admin` and `/api/admin/*` on the customer host answer 404 (scripts move to the admin host). |
| 1659 | An active owner is an enabled owner with a password and an authenticator. Only active owners count for "an owner exists" (bootstrap) and for the last-owner check; disable, enable, role change, reset and bootstrap decide and write under one `lock:staff:owners`. |

### Tests to pin (`tests/`)

- `tests/staff-identity.test.ts` (new): 1630 (a customer session for an address that also has a staff record is not a staff actor; a staff session is never `currentUser()`), 1631 (the same refusal and status for unknown, wrong, disabled and locked; the dummy compare runs), 1632 (no session without a code; enrol before a session on the first sign-in), 1637 (`support` and unknown roles refused on a write; create refuses non-`owner`), 1639 (bootstrap needs a key session, needs the console code when enrolled, 409 once an owner exists, the code is single use and expires after 30 min), 1640, 1641 (each refusal; equality with the customer password refused), 1642, 1643 (no staff route sends mail; a reset code works once), 1644 (lock after 10, unlock after the window, key path unaffected, one `admin:log` row), 1654 (opens after a rotation with the previous key; resealed).
- `tests/staff-session.test.ts` (new): 1633 (exact `Set-Cookie` attributes; the dev name only on loopback http), 1634 (idle and absolute limits checked in code; renewal at most once a minute; a renewal after logout does not revive), 1635, 1636 (step-up tied to the staff cookie; fresh code required for the listed actions), 1648 (the customer view ends with the staff session), 1652 (redirect through `safeNext`).
- `tests/launch-security.test.ts` (update): 1645, 1646, 1647, 1649, 1650 (switch refused for key and customer actors; after it, `adminActor` ignores customer sessions), 1653.
- `tests/admin-2fa.test.ts` (update): a staff actor's code is checked against its own secret; the console enrolment still gates key actors.
- `tests/admin-shell.test.ts` (update): banners in Arabic and English, the redirect instead of the 404.
- Coverage file: `docs/system/tests/1630-staff-identity.md`, written with the build.

## Phase 2 (needs founder setup, later)

1. Google sign-in for staff restricted to the company domain (rule 1655). Its own OAuth client, separate from the customer sign-in client of `docs/specs/2026-10-13-google-sign-in.md`, with a consent screen of type "Internal" (available only to a Google Workspace organisation) and a redirect to the admin host. Server checks: signature, issuer, audience, expiry, nonce, PKCE, `email_verified` true, `hd` equal to the company domain AND the address ending in it (the `hd` request parameter is only a hint to Google's account picker, so the check must be server-side), and an existing, enabled `staff:{email}` record, keyed to the Google `sub` after the first link. Google sign-in replaces the password, not the second step: a passkey or the authenticator code still follows.
2. Passkeys (rule 1656): registered from the account page with a fresh code; at sign-in a passkey replaces the 6-digit code. Needs a WebAuthn server library (a new dependency: regenerate the lockfile as `CLAUDE.md` says). No founder setup beyond choosing to use one; it is in phase 2 because it should bind to the final admin host.
3. A separate host, `admin.thakeen.com` (rules 1657-1658): the proxy serves only console paths on that host and only customer paths on `thakeen.com`; cookies are host-only (`__Host-`), so no customer cookie reaches the console host and no staff cookie reaches the customer host. Because `admin.thakeen.com` and `thakeen.com` are the same site for `SameSite` purposes, the Origin pin of rule 1657 is what stops a request forged from the customer host; a completely separate registrable domain would be stronger still, and is an option the founder can choose instead.

Phase 2 environment variables (names only): `ADMIN_ORIGIN` (the admin host's origin), `STAFF_GOOGLE_CLIENT_ID`, `STAFF_GOOGLE_CLIENT_SECRET` (a secret), `STAFF_GOOGLE_DOMAIN`. Each unset means that feature is off.

Founder steps for phase 2 (each goes onto the founder action checklist when phase 2 is scheduled):

1. Decide whether thakeen.com gets Google Workspace accounts (a paid Google subscription; mail is on Hostinger today). Without it, Google sign-in for staff waits, and passkeys alone give phishing resistance.
2. Hostinger hPanel: add `admin.thakeen.com` to the SAME website as `thakeen.com` (an alias of the existing site, not a new website, which would be a second app with its own variables), create the DNS record, issue its SSL certificate, and open `https://admin.thakeen.com` once to confirm it reaches the app.
3. hPanel: set `ADMIN_ORIGIN` (never in chat); then the phase 2 release.
4. With Workspace: a Google Cloud OAuth client (Web application), consent screen "Internal", redirect `https://admin.thakeen.com/api/admin/staff/google/callback`, scopes `openid email profile`; put the two values and the domain in hPanel.
5. Register a passkey from the console account page (phone or security key), and keep the recovery codes offline.

## Risks

- Lock-out during rollout: avoided by expand first, by a runtime switch that only a working staff owner can set, and by the key break-glass that no staff lock touches.
- Same-origin XSS in phase 1 is reduced, not closed; phase 2's host split is the fix and should not slip for long.
- Two authenticators for the founder (the console key's code and his staff code). Accepted: one is for emergencies only.
- `SameSite=Strict` makes links from email or chat land on the sign-in page; accepted (rule 1652 makes it a redirect, not a 404).
- A `CONNECT_SECRET` rotation without `CONNECT_SECRET_PREVIOUS` set makes staff secrets unreadable; staff then use recovery codes, or the key path issues resets.

## Phase 1 build plan (one draft pull request after `claude/admin-2fa-qr` merges)

1. `src/lib/staff.ts`: the `Staff` record, index, password policy, sealing with `kid`, recovery codes; unit tests (1630, 1641, 1642, 1654).
2. `src/lib/staff-session.ts`: session and pre-auth records, cookies, renewal, `sessionsAfter`; tests (1633-1635).
3. Sign-in routes: login, code, enrol, setup, sign-out, with limits and the lock; tests (1631, 1632, 1640, 1643, 1644).
4. Console gate: `adminActor` / `isAdminCookie` / `requireAdmin` read the staff session; the request `WeakMap`; the staff step-up and role check in `secondFactorRefusal`; the Origin check; tests (1636, 1637, 1647, 1649).
5. Bootstrap, staff management, `me`, and the customer-path switch, with audit events; tests (1638, 1639, 1650).
6. The key form as break-glass (console code once enrolled, `key.login`, banner); tests (1645, 1646).
7. Impersonation binding `ss` in `createSession` / `resolveSession`; tests (1648).
8. Pages: login, setup, staff, account, the banners and the redirect (QR component from the other branch); tests (1652, 1653).
9. Docs: architecture, flows (new section), permissions (rows above), variables (meaning notes, no new name), `docs/system/tests/1630-staff-identity.md`; the release pull request names the step "expand".

Later: the contract release (rule 1651), once the founder has signed in with his staff login and switched the customer path off.
