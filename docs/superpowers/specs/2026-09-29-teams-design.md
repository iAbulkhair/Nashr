# Teams (seats) — design

Decided 2026-09-29. Pricing context: `docs/superpowers/specs/2026-09-29-pricing-design.md` (seats 1 / 3 / 7). Built from
a map of every identity touchpoint in the codebase and a completeness critic's review of it.

## 1. Model

- The **account** stays today's `User` record at `user:{ownerEmail}`. Credits, plan, brands, scope `sc(u)`, usage,
  governance, cron, admin stats: unchanged. `currentUser()` keeps returning the owner's record, so the ~150 tenant and
  credit call sites do not change.
- A **member** is a separate login at `member:{email}`. Members are never written with `saveUser` / `createUser`, never
  enter `users:all`, and never get trial credits, referral codes or signup tracking.
- Who is acting travels as a runtime-only `actor` on the `User` object. `saveUser` strips it. A request with no actor is
  denied by every role check (fail closed).

```ts
export type Role = "owner" | "admin" | "member";
export type Actor = {
  kind: "owner" | "member" | "token" | "founder";   // founder = a founder impersonating this account
  email: string;            // the login that is acting (owner email for owner, token and founder kinds)
  name: string;
  lang: "ar" | "en";
  role: Role;
  impersonating?: string;   // founder email, only for kind "founder"
};
// User gains: actor?: Actor (runtime only), seats?: number (founder override), teamSessionsAfter?: string

export type Member = {
  email: string; name: string; lang: "ar" | "en"; passHash: string;
  memberOf: string;         // owner email
  role: "admin" | "member";
  invitedBy: string; acceptedAt: string; sessionsAfter?: string;
  disabled?: "seats";       // set by enforceSeats when a plan shrinks; never deleted for it
};
export type Invite = {
  email: string; role: "admin" | "member"; owner: string; invitedBy: string;
  createdAt: string; expiresAt: string; lang: "ar" | "en";
};
```

## 2. Storage keys

| Key | Value |
|---|---|
| `member:{email}` | `Member` |
| `members:{owner}` | set of member emails |
| `invite:{sha256(token)}` | `Invite`, TTL 7 days |
| `invites:{owner}` | set of invite hashes |
| `lock:team:{owner}` | seat-count lock (invite, accept, role change, plan change) |
| `lock:login:{email}` | login-uniqueness lock (signup, accept) |
| `lock:member:{email}` | member record writes (password, name) |
| `inviteuse:{hash}` | single-use lock at accept |
| `activebrand:{actorEmail}` | active brand is per login now (owner key unchanged) |
| `session:{token}` | `{ email, at, imp? }` — `imp` = founder email on an impersonation session |

The invite token is 32 random bytes, stored only as its SHA-256, carried in the URL **fragment**
(`/{lang}/app/join#t=…`) so it never reaches server or edge logs. No new environment variable.

## 3. Resolving a request

`currentUser()`:

1. Read `session:{token}`. Then `Promise.all([getUser(e), getMember(e)])`.
2. **Owner login** (`user:{e}` exists): today's checks (suspended, `sessionsAfter`). Actor `{kind:"owner", role:"owner"}`,
   or `{kind:"founder", role:"owner", impersonating: s.imp}` when the session carries `imp`.
3. **Member login** (`member:{e}` exists): refuse when `disabled`, when `s.at < member.sessionsAfter`, when the owner
   record is missing or suspended, when `s.at < owner.teamSessionsAfter`, or when `member.acceptedAt < owner.createdAt`
   (a re-registered owner address never inherits an old team). Membership is re-resolved on every request; the owner
   email is never cached in the session.
4. Scope is always `scopeFor(OWNER email, brandId)`. A member's `brandId` comes from `activebrand:{member}` and is
   validated against the owner's active brands, falling back to `default`.
5. `userFromBearer` (MCP): tokens are minted by owners only, so a bearer resolves only to an owner record. Actor
   `{kind:"token", role:"owner"}`. A token whose email is a member login is refused.

`getLogin(email)` returns `{kind:"owner", user}`, `{kind:"member", member, owner}` or `null`, and is what login, forgot,
reset and signup use. An email is unique across `user:`, `member:` (checked under `lock:login:{email}`).

## 4. Roles

`src/lib/roles.ts` holds one table, `can(u, action)`, used by every route, chat tool and page. `forbid(u, action)`
returns a 403 `Response` or `null`.

| Needs | Actions |
|---|---|
| **owner** | billing and plan; account delete; governance writes; MCP personal token (mint, revoke, status); OAuth consent and connected apps; referral data; account-level profile fields (phone, WhatsApp, account language, email preferences); invite or promote an admin; change any role; remove an admin |
| **admin+** | brand file writes (route, profile brand fields, chat `update_brand`); brands add / rename / archive; onboarding and onboard confirm/plan; catalog import; connectors (start, callback, key, disconnect, page and ad-account select); schedule and routines; approve and publish (route, task approve, chat `publish_item`); core memory file write and delete (route and chat `write_file`: writing one empty is deleting it); performance import and delete (an import replaces the last); invite or remove plain members; view pending invites |
| **member** | chat, generate, images, drafts (edit, reject), conversations, feedback, notifications, tools, support, integration requests, switching the active brand, reading everything, leaving the team |

Blocked while a founder impersonates: account delete, own password change, invites, role changes, member removal, MCP
token, OAuth approval.

Founder console: `isAdmin` / `isAdminCookie` / the sidebar flag require `actor.kind === "owner"` **and**
`isFounder(actor.email)`. A member of the founder's own account, and a founder impersonating someone, never pass.

A fail-closed test walks every route handler of every method under `src/app` and requires it in a declared
route-to-role map (reads included, since a GET can change state), with each declared action checked in that handler
and its refusal returned.

## 5. Seats

`PLAN_SEATS`: trial 3, starter 1, pro 3, agency 7, enterprise 25; `User.seats` overrides (founder console). Since
pricing phase 1 (2026-09-30) `PLAN_SEATS` lives in `src/lib/pricing.ts` and reads trial 3, starter 1, pro 3, business 7;
Agency has no fixed number (`seatLimit` gives it Business's 7 unless `User.seats` is set for its contract), and a stored
`enterprise` reads as agency. Seats used =
1 (owner) + members not disabled + unexpired invites, counted under `lock:team:{owner}` at invite and again at accept.
`enforceSeats(owner)` runs on every plan change: newest members over the limit get `disabled: "seats"` (kept, never
deleted), and are re-enabled oldest-first when the limit grows. Trial → Starter therefore disables up to two members
until the owner upgrades.

## 6. Flows

- **Invite** (`POST /api/team/invite`, owner; admin for role `member` only). Validates and normalises the email, refuses
  the owner's own address, an existing login and a pending invite with one generic error, rate limited per account and
  per IP, seat check under lock. Sends the link by email when mail is configured (a fixed template naming the inviting
  login's address; a failed send withdraws the invite and returns no link); only when mail is not configured is it
  returned once to the inviter. The owner is notified without the invitee's address (the bell is shared).
- **Peek and accept** (`POST /api/team/accept`, public, rate limited per IP). `{token}` alone returns a preview (team
  name, inviter, invited email, role) without consuming. `{token, name, password}` consumes under `inviteuse:{hash}`:
  re-checks expiry, owner exists and not suspended, inviter still admin+ in the team, seats, and login uniqueness under
  `lock:login`; creates the member with `sessionsAfter = acceptedAt`; signs them in.
- **Member login / forgot / reset / password change** act on the member record only. A member can never touch the
  owner's hash, tokens or sessions.
- **Leave** (`POST /api/team/leave`, member). **Remove** (`DELETE /api/team/member`, owner; admin for plain members):
  deletes `member:{m}`, `activebrand:{m}`, the index entry and invites that member sent. **Role change**
  (`PATCH /api/team/member`, owner). The owner role cannot be removed, demoted or transferred in v1.
- **Account delete** (owner only) cascades: every member login, invite, index and member `activebrand`.
- **Founder reset** stamps `teamSessionsAfter`, signing every member out.

## 7. UI

- `/{lang}/app/team` — "Members" / "الأعضاء" (the AI agents are already "the team"): roster, seats used of limit,
  invite form, pending invites, role change, remove, leave.
- `/{lang}/app/join` — public; reads the token from the fragment, shows the preview, asks for name and password.
- Sidebar shows the acting person's name and role; the founder link follows the actor.
- Owner-only and admin+ screens render read-only for lower roles with a one-line note; the server enforces regardless.
- Pricing copy states seats that exist: 1 / 3 / 7 and custom, no "coming soon" seat lines.

## 8. Later (not in v1)

Per-actor attribution on decisions, approvals, publishes and brand edits (`by` fields); per-actor notification read
state and owner-only billing notices; per-actor chat sub-limits; MCP tokens for members; ownership transfer.
