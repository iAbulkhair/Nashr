import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { json, newMember, newUser, params, signIn, signOut, jar, type Fixture, readActiveBrand } from "./helpers/session";
import { vjson } from "./helpers/version";
import { currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { getBrand, getTask, saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { db } from "@/lib/db";
import { getGov, listGovHistory, saveGovAs } from "@/lib/governance";
import { getSchedule } from "@/lib/schedule";
import { MCP_TOOL_ACTION, createMcpToken, getMcpToken } from "@/lib/mcp";
import { tokenHash } from "@/lib/oauth";
import { CORE_FILES, readFile, writeFile } from "@/lib/files";
import { OAUTH_COOKIE, getConnection, saveConnection, saveState } from "@/lib/connectors/store";
import { MIN_ROLE, type Action } from "@/lib/roles";
import { TOOL_ACTION as CHAT_TOOL_ACTION, runTool } from "@/lib/chat";

// No network: publishing is replaced, so a gate that failed would show up as an entry here rather than a real post.
const published: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: Task, provider: string) => { published.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

import * as governanceRoute from "@/app/api/governance/route";
import * as rollbackRoute from "@/app/api/governance/rollback/route";
import * as activityRoute from "@/app/api/activity/route";
import * as activityExportRoute from "@/app/api/activity/export/route";
import { recordActivity } from "@/lib/activity";
import * as tokenRoute from "@/app/api/mcp/token/route";
import * as grantsRoute from "@/app/api/mcp/grants/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as approveRoute from "@/app/api/oauth/approve/route";
import * as referralRoute from "@/app/api/referral/route";
import * as shareRoute from "@/app/api/referral/share/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as brandRoute from "@/app/api/brand/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as scheduleRoute from "@/app/api/schedule/route";
import * as startRoute from "@/app/api/connect/[provider]/start/route";
import * as callbackRoute from "@/app/api/connect/[provider]/callback/route";
import * as connRoute from "@/app/api/connect/[provider]/route";
import * as keyRoute from "@/app/api/connect/[provider]/key/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as filesRoute from "@/app/api/files/route";
import * as perfRoute from "@/app/api/performance/route";
import * as onboardConfirm from "@/app/api/onboard/confirm/route";
import * as onboardRoute from "@/app/api/onboard/route";
import * as onboardPlanRoute from "@/app/api/onboard/plan/route";
import * as catalogRoute from "@/app/api/catalog/route";

/**
 * Teams, role gates (docs/superpowers/specs/2026-09-29-teams-design.md §4). Who may do what is one table,
 * src/lib/roles.ts, checked in code in every route, chat tool and MCP call: hiding a button is display only.
 *
 * Part one is static and fails closed: every mutating handler under src/app/api must be declared below with the role it
 * needs, and a new handler nobody declared fails the suite until someone decides who may call it. Part two drives the
 * real handlers with real member sessions.
 */

// ── Part one: the route-to-role map ──────────────────────────────────────────────────────────────────────────────────

type Role = "owner" | "admin" | "member";
/**
 * public: no session (rate limited per IP when it writes). public-read: a GET, HEAD or OPTIONS with no session that
 * serves only public metadata, a static list or a CORS preflight, and writes nothing. bearer: the MCP token.
 * unverified-session: the email-verification routes, called by an owner who `currentUser` still reads as signed out (rule 751): the handler must read `currentUserUnverified` and be rate limited (allow).
 * admin-console: the founder console. cron: the CRON_SECRET bearer. owner / admin / member: a session, and at least
 * that role, checked with forbid()/can() for the listed actions of src/lib/roles.ts (a bare "member" needs only the
 * session).
 */
type Gate = "public" | "public-read" | "cron" | "admin-console" | "bearer" | "unverified-session" | "member" | { role: Role; actions: Action[] };
const g = (role: Role, ...actions: Action[]): Gate => ({ role, actions });

/** Every POST, PUT, PATCH and DELETE handler anywhere under src/app. */
const ROUTE_ROLES: Record<string, Gate> = {
  // Public: nobody is signed in yet, or the caller only ends their own session.
  "POST /api/auth/login": "public",
  // The second sign-in step (rule 1934): the challenge cookie names the login, rate limited with the login buckets.
  "POST /api/auth/login/mfa": "public",
  // Passkey sign-in (rules 2417, 2418): the sign-in nonce cookie carries the challenge; limited per IP and per credential.
  "POST /api/auth/passkey/options": "public",
  "POST /api/auth/passkey/verify": "public",
  "POST /api/auth/signup": "public",
  "POST /api/auth/forgot": "public",
  "POST /api/auth/reset": "public",
  "POST /api/auth/logout": "public",
  // Email verification (rules 759-761): the caller is an owner who is still signed out for `currentUser` (rule 751), so the
  // routes read `currentUserUnverified` and refuse without it; both are rate limited (allow).
  "POST /api/auth/verify/send": "unverified-session",
  "POST /api/auth/verify/check": "unverified-session",
  "POST /api/auth/verify/email": "unverified-session",
  "POST /api/team/accept": "public",
  "POST /api/support": "public",
  "POST /api/affiliates": "public",
  "POST /api/waitlist": "public",
  "POST /api/tools/[tool]": "public",
  "POST /api/oauth/register": "public",
  "POST /api/oauth/token": "public",
  // A booking tool's webhook (Reem B2a): the token in the path locates the link and the provider's signature over the body proves the sender; rate limited per IP and per link.
  "POST /api/secretary/booking/[token]": "public",
  // The staging site's door (rule 675): 404 off staging, rate limited per IP, the access code in the form body is the credential (sameSecret).
  "POST /api/staging-access": "public",
  // Every other method of the door is a bare 404 that reads and writes nothing (rule 675), so no limit.
  "PUT /api/staging-access": "public",
  "PATCH /api/staging-access": "public",
  "DELETE /api/staging-access": "public",

  "POST /api/mcp": "bearer",
  // Reem's tick: a signed QStash call (src/lib/qstash.ts) or the CRON_SECRET bearer, rate limited per IP first.
  "POST /api/cron/secretary": "cron",

  "POST /api/admin/login": "admin-console",
  "DELETE /api/admin/login": "admin-console",
  // Staff identity (rules 1630-1654): the sign-in steps are public and rate limited; the rest is the console.
  "POST /api/admin/staff/login": "public",
  "DELETE /api/admin/staff/login": "admin-console",
  "POST /api/admin/staff/login/code": "public",
  "POST /api/admin/staff/login/enrol": "public",
  "POST /api/admin/staff/setup": "public",
  "POST /api/admin/staff/bootstrap": "admin-console",
  "POST /api/admin/staff": "admin-console",
  "POST /api/admin/staff/me": "admin-console",
  "POST /api/admin/staff/config": "admin-console",
  // The founder console second factor (rules 1370-1384): enrolment and the code prompt, founder or console key only.
  "POST /api/admin/2fa": "admin-console",
  "POST /api/admin/golden": "admin-console",
  "POST /api/admin/impersonate": "admin-console",
  "POST /api/admin/plan": "admin-console",
  "POST /api/admin/brand-cap": "admin-console",
  // The fair-use stop (rule 1730): the founder lifts or re-applies one account's pause for this month.
  "POST /api/admin/fair-use": "admin-console",
  // Partner programme (rules 390-402): approvals, payouts, recorded payments and voids.
  "POST /api/admin/partners": "admin-console",
  "POST /api/admin/payments/[email]": "admin-console",
  "POST /api/admin/founding": "admin-console", // second factor, reason, audit (rule 1710)
  "POST /api/admin/users/[email]": "admin-console",
  // Credit top-ups, activated by hand while there is no payment gateway (rules 446-447): the founder only.
  "POST /api/admin/topups": "admin-console",
  // Agent scope (rule 1411): the founder releases one held item.
  "POST /api/admin/agent-scope/release": "admin-console",
  // Agent scope (rule 1412): the switches and the paid test set.
  "POST /api/admin/agent-scope/modes": "admin-console",
  // Customer passkeys off switch (rule 2426): the console owner only (staffMay "passkeys.switch"), second factor, reason, audit.
  "POST /api/admin/passkeys": "admin-console",
  "POST /api/admin/agent-scope/eval": "admin-console",

  // Owner only.
  "PUT /api/governance": g("owner", "governance.write"),
  "POST /api/governance/rollback": g("owner", "governance.write"), // a restore is a governance write
  "POST /api/mcp/token": g("owner", "mcp.token"),
  "DELETE /api/mcp/token": g("owner", "mcp.token"),
  "DELETE /api/mcp/grants": g("owner", "oauth.grants"),
  "POST /api/oauth/approve": g("owner", "oauth.approve"),
  "POST /api/referral/share": g("owner", "referral"),
  // A partner's bank details (refused while impersonating), and the billing page's partner-code field.
  "PUT /api/partner": g("owner", "partner.bank"),
  "POST /api/partner/code": g("owner", "billing"),
  "DELETE /api/account": g("owner", "account.delete"),
  "PUT /api/profile": g("owner", "profile.account", "brand.write", "profile.self"),
  "PATCH /api/team/member": g("owner", "team.role"),
  "POST /api/billing/chat-overflow": g("owner", "billing"), // how the account's credits are spent once chat runs out
  // The model picks (plan Task 6): a conversation's by any login, the active brand's by an admin, the China-hosting
  // confirmation by the owner only. One handler serves all three, like PATCH /api/tasks/[id].
  "PUT /api/models": g("owner", "conversations", "brand.write", "profile.account"),
  "POST /api/billing/checkout": g("owner", "billing.pay"), // online payment (Paymob), never while impersonating
  "POST /api/billing/renewal": g("owner", "billing.pay"), // the online subscription's renewal and saved card

  // Admin and owner (some handlers also serve a member-level action, listed with it, or member-level names such as
  // non-core files, which need no action of their own).
  "PUT /api/brand": g("admin", "brand.write"),
  "POST /api/brand/proposals/[id]": g("admin", "brand.write"),
  // Agent instructions of the brand workspace (agent skills portal, rule 949).
  "PUT /api/instructions": g("admin", "instructions.write"),
  "POST /api/instructions/activate": g("admin", "instructions.write"),
  "POST /api/instructions/discard": g("admin", "instructions.write"),
  "POST /api/instructions/restore": g("admin", "instructions.write"),
  "POST /api/instructions/refs/search": g("admin", "instructions.write"),
  "POST /api/instructions/refs/import": g("admin", "instructions.write"),
  "POST /api/instructions/test": g("admin", "instructions.test"),
  // Applying or dismissing an instruction an agent proposed in chat (rules 953-954): the owner's click is the only approval.
  "POST /api/instructions/proposals/[id]": g("admin", "instructions.write"),
  // Core-file rewrite cards (rule 2306): Apply writes a file every agent reads.
  "POST /api/files/proposals/[id]": g("admin", "files.core.write"),
  "POST /api/brands": g("admin", "brands.manage", "brands.switch"),
  "POST /api/catalog": g("admin", "catalog.import"),
  "POST /api/connect/[provider]": g("admin", "connectors", "catalog.import", "read", "generate"),
  "DELETE /api/connect/[provider]": g("admin", "connectors"),
  "POST /api/connect/[provider]/key": g("admin", "connectors"),
  "POST /api/onboard": g("admin", "onboard"),
  "POST /api/onboard/confirm": g("admin", "onboard"),
  "POST /api/onboard/plan": g("admin", "onboard"),
  "PUT /api/schedule": g("admin", "schedule.write"),
  "POST /api/publish/[id]": g("admin", "publish"),
  "PATCH /api/tasks/[id]": g("admin", "publish", "drafts"),
  "PUT /api/files": g("admin", "files.core.write"),
  "DELETE /api/files": g("admin", "files.core.delete"),
  "POST /api/performance": g("admin", "performance.import"),
  "DELETE /api/performance": g("admin", "performance.delete"),
  "POST /api/team/invite": g("admin", "team.invite.member"),
  "DELETE /api/team/invite": g("admin", "team.invite.cancel"),
  "DELETE /api/team/member": g("admin", "team.remove.member"),
  // Reem's list: any member adds and changes items; closing, confirming or sending back a claim, deleting and restoring
  // need an admin (the same handler serves both, like PATCH /api/tasks/[id]).
  "PATCH /api/secretary/[id]": g("admin", "todo.write", "todo.close"),
  // Reem's Working days (weekend, Ramadan hours, Eid sightings, holidays): a brand setting, so an admin saves it; every member reads it.
  "PUT /api/secretary/calendar": g("admin", "brand.write"),
  // The one calendar Reem reads (Reem B3): the owner alone links, chooses and unlinks it, and reads its state.
  "PUT /api/secretary/calendar-link": g("owner", "calendar.link"),
  "DELETE /api/secretary/calendar-link": g("owner", "calendar.link"),
  // Keeping a series' history is a to-do write; stopping to keep it lets the daily job delete it, so it also needs todo.close (checked in code, a member gets 403).
  "PUT /api/secretary/series/[seriesId]/keep": g("admin", "todo.write", "todo.close"),

  // Every member of the account.
  "PATCH /api/account": g("member", "password.change"),
  // Sign out other devices (rule 1150): the caller's own sessions only, never while impersonating.
  "POST /api/account/sessions": g("member", "sessions.revoke"),
  // One device out of the login's own list (rule 1939).
  "DELETE /api/account/sessions": g("member", "sessions.revoke"),
  // The login's own two-step sign-in (rules 1930-1937).
  "POST /api/account/2fa": g("member", "mfa.manage"),
  // The login's own passkeys (customer passkeys, rule 2412): member-level, refused while impersonating.
  "POST /api/account/passkeys": g("member", "passkeys.manage"),
  "POST /api/account/email": g("member", "email.change"),
  "POST /api/account/google": g("member", "google.manage"),
  // Notification preferences per type and channel (rule 1145): the account's settings, owner only.
  "PUT /api/notifications/prefs": g("owner", "profile.account"),
  "PUT /api/notifications/digest": g("owner", "profile.account"),
  // Phone notifications (rules 2562-2567): a person's own device in the workspace they act in; tokens and founder views get 403 in the route.
  "POST /api/push": "member",
  "DELETE /api/push": "member",
  "POST /api/push/seen": "member",
  "POST /api/team/leave": g("member", "team.leave"),
  "POST /api/chat": "member",
  "POST /api/chat/feedback": "member",
  "POST /api/conversations": "member",
  "PATCH /api/conversations": "member",
  "DELETE /api/conversations": "member",
  "POST /api/generate": "member",
  "POST /api/integrations": "member",
  "POST /api/notifications": "member",
  "POST /api/schedule": "member", // run now: an explicit request, charged like generate
  "POST /api/tasks/[id]/image": "member",
  "POST /api/tasks/[id]/video": "member",
  "POST /api/wishlist/suggest": "member",
  "POST /api/wishlist/vote": "member",
  "POST /api/secretary": g("member", "todo.write"),
  // Cloud drives and the media library (rules 1781-1785): any member, export never while impersonating.
  "POST /api/drives": g("member", "library.write", "library.export"),
  "DELETE /api/drives": g("member", "library.write"),
  "POST /api/media/upload": g("member", "library.write"),
  // Reem's "Walk me through": skipping a card is a change to the list's state; the card's own buttons call gated routes.
  "POST /api/secretary/walk": g("member", "todo.write"),
  // Reem's away list: any member marks a contact away and ends it (the owner and the agents are refused in code).
  "PUT /api/secretary/away": g("member", "todo.write"),
  "DELETE /api/secretary/away": g("member", "todo.write"),
  // Saving or dismissing an absence Reem proposed in chat: the same role as marking a contact away on the page.
  "POST /api/secretary/away/proposals/[id]": g("member", "todo.write"),
  // One's own private calendar feed link: any member manages their own, refused while a founder impersonates (rule 533).
  "POST /api/secretary/feed": g("member", "feed.manage"),
  "DELETE /api/secretary/feed": g("member", "feed.manage"),
  // One's own booking links (Reem B2a): the same, with their own action (rule 596).
  "POST /api/secretary/booking": g("member", "booking.manage"),
  "DELETE /api/secretary/booking": g("member", "booking.manage"),
  // The follow-up after a meeting (Reem B2b, rules 600-603): discarding the proposals and approving some of them (the one path that makes items) are the same role as any Reem write.
  "DELETE /api/secretary/meeting/[id]": g("member", "todo.write"),
  "POST /api/secretary/meeting/[id]/approve": g("member", "todo.write"),
  // Proposing from notes or a transcript (Task 10, rules 604-606) only writes the pending set; it spends the account's credits, so it is `todo.write` like the other Reem writes.
  "POST /api/secretary/meeting/[id]/propose": g("member", "todo.write"),
  // Majed's handoffs: a run spends credits like a generation; a decline is a draft decision, like rejecting an item.
  "POST /api/handoffs/[id]/run": g("member", "generate"),
  "POST /api/handoffs/[id]/decline": g("member", "drafts"),
  // Run on a chat spend card (rule 1512): it spends credits like a generation (a render also checks `images`, also member).
  "POST /api/chat/spend/[id]": g("member", "generate"),
  "POST /api/admin/wishlist": "admin-console",
  "POST /api/admin/skills": "admin-console",
  "PUT /api/admin/skills": "admin-console",
  "POST /api/admin/leads": "admin-console",
  "POST /api/media/hook/[provider]": "public",
  "POST /api/billing/paymob/webhook": "public", // Paymob callbacks: HMAC only, rules 700-729
  "POST /api/shopify/compliance": "public", // Shopify compliance webhooks: HMAC only, rules 2168-2171
  // The ops agent (rules 2380-2389): no session; per-IP allow() first, then a sameSecret token (OPS_AGENT_TOKEN, or
  // Telegram's webhook secret), 401 while unset. The summary is counts only; the press runs only OPS_ACTIONS, once.
  "POST /api/ops/telegram": "public",
  "POST /api/ops/telegram/callback": "public",
};

/**
 * Every GET, HEAD and OPTIONS handler anywhere under src/app, declared like the writes: a read nobody declared fails the
 * suite too, because a GET can change state (an OAuth start saves state, a callback saves a connection, a cron runs
 * batch jobs) and would otherwise be checked only if someone remembered to list it.
 */
const READS: Record<string, Gate> = {
  "GET /api/connect/[provider]/start": g("admin", "connectors"),
  "GET /api/connect/[provider]/callback": g("admin", "connectors"),
  "GET /api/mcp/token": g("owner", "mcp.token"),
  "GET /api/mcp/grants": g("owner", "oauth.grants"),
  "GET /api/referral": g("owner", "referral"),
  "GET /api/referral/share": g("owner", "referral"),
  // A partner link: sets the 30-day partner cookie for a valid code, so it is a public write with a rate limit (rule 391).
  "GET /p/[code]": "public",
  "GET /api/team": g("member", "team.view"),
  "GET /api/profile": g("member", "read"),
  // The owner's own data download (rule 1320): owner only, refused while impersonating, rate limited.
  "GET /api/account/export": g("owner", "account.export"),
  // The login's own two-step status and device list (rules 1930, 1938): a session, nothing written.
  "GET /api/account/2fa": "member",
  // The passkey list (rule 2412): refused while impersonating, so no founder reads a customer's passkeys.
  "GET /api/account/passkeys": g("member", "passkeys.manage"),
  "GET /api/auth/google/start": "public",
  "GET /api/auth/google/callback": "public",
  "GET /api/account/email": g("member", "email.change"),
  "GET /api/account/google": g("member", "google.manage"),
  "GET /api/account/sessions": "member",
  // The Paymob return page's poll (rule 1155): the caller's own last checkout and plan, owner only.
  "GET /api/billing/status": g("owner", "billing"),
  "GET /api/activity": g("member", "read"),
  "GET /api/activity/export": g("member", "read"),
  "GET /api/handoffs/[id]": g("member", "read"),
  "GET /api/media/[jobId]": "member",
  // Our media files (rules 1754-1758): a signed-in member of the workspace that holds the file, or a short signed link
  // minted at hand-off; both checked inside, everything else is the same 404. Rate limited per IP first, so "public".
  "GET /m/[name]": "public",
  "HEAD /m/[name]": "public",

  "GET /api/cron/daily": "cron",
  "GET /api/cron/weekly": "cron",
  "GET /api/cron/golden": "cron",
  "GET /api/cron/routines": "cron",
  "GET /api/cron/media": "cron",
  "GET /api/cron/evening": "cron",
  "GET /api/cron/stores": "cron",

  "GET /api/admin/agent-scope": "admin-console",
  "GET /api/admin/evals": "admin-console",
  "GET /api/admin/export": "admin-console",
  "GET /api/admin/founding": "admin-console",
  "GET /api/admin/2fa": "admin-console",
  "GET /api/admin/staff": "admin-console",
  "GET /api/admin/golden": "admin-console",
  "GET /api/admin/media": "admin-console",
  "GET /api/admin/wishlist": "admin-console",
  "GET /api/admin/skills": "admin-console",
  "GET /api/admin/integrations": "admin-console",
  "GET /api/admin/passkeys": "admin-console", // rule 2426: the switch state for the Integrations page toggle
  "GET /api/admin/leads": "admin-console",
  "GET /api/admin/client-ip": "admin-console",
  "GET /api/admin/log": "admin-console",
  "GET /api/admin/overview": "admin-console",
  "GET /api/admin/plan": "admin-console",
  "GET /api/admin/partners": "admin-console",
  "GET /api/admin/payments/[email]": "admin-console",
  "GET /api/admin/users/[email]": "admin-console",
  "GET /api/admin/users/[email]/workspace": "admin-console", // rule 2077: read-only workspace view, staffMay("workspace.view") after the console gate
  "GET /api/affiliates": "admin-console",
  "GET /api/waitlist": "admin-console",
  "GET /api/support": "admin-console",
  "GET /api/integrations": "admin-console", // the founder gets the request log; anyone else the static catalogue

  "GET /api/brand": "member",
  "GET /api/brands": "member",
  "GET /api/brief": "member",
  "GET /api/chat": "member",
  "GET /api/models": "member", // the picker: catalog ids, labels, tiers, multipliers; never a rate
  "GET /api/connect": "member",
  "GET /api/conversations": "member",
  "GET /api/files": "member",
  "GET /api/drives": "member",
  "GET /api/governance": "member",
  "GET /api/instructions": "member",
  "GET /api/instructions/refs": "member",
  "GET /api/instructions/history": "member",
  "GET /api/notifications": "member",
  // The text a woken phone worker shows (rule 2567), read with the device's own session.
  "GET /api/push/latest": "member",
  "GET /api/onboard/plan": "member",
  "GET /api/performance": "member",
  "GET /api/schedule": "member",
  "GET /api/tasks": "member",
  "GET /api/tasks/[id]/pptx": "member",
  "GET /api/secretary": "member",
  "GET /api/secretary/walk": g("member", "read"),
  "GET /api/secretary/away": g("member", "read"),
  "GET /api/secretary/calendar": g("member", "read"),
  "GET /api/secretary/calendar-link": g("owner", "calendar.link"),
  "GET /api/secretary/calendar-link/calendars": g("owner", "calendar.link"),
  "GET /api/secretary/series/[seriesId]/export": g("member", "read"),
  "GET /api/secretary/feed": g("member", "read"),
  "GET /api/secretary/booking": g("member", "read"),
  "GET /api/secretary/meeting/[id]": g("member", "read"),

  "GET /api/mcp": "public-read",
  "GET /api/secretary/feed/[token]": "public-read", // the token in the path is the credential; rate limited per IP and per link
  "GET /api/oauth/meta": "public-read",
  "GET /api/oauth/resource": "public-read",
  "GET /llms.txt": "public-read", // site copy for language models, static at build time (rule 698)
  "GET /api/founding/seats": "public-read", // seats left only, closed while payment is off; rate limited per IP (rule 1711)
  "GET /api/ops/summary": "public-read", // the ops agent's counts (rules 2380-2382): OPS_AGENT_TOKEN bearer (sameSecret) after a per-IP allow(); no email, name or workspace
  "GET /api/health": "public-read", // the release probe's build identity (rule 676): { ok, commit, built } only; rate limited per IP, and still answers when the limiter's store is down
  "GET /api/staging-access": "public-read", // a bare 404, so the door shows nothing off staging (rule 675)
  "HEAD /api/staging-access": "public-read",
  "OPTIONS /api/staging-access": "public-read",
  "OPTIONS /api/mcp": "public-read",
  "OPTIONS /api/oauth/meta": "public-read",
  "OPTIONS /api/oauth/register": "public-read",
  "OPTIONS /api/oauth/resource": "public-read",
  "OPTIONS /api/oauth/token": "public-read",
};

/**
 * Public writes without a rate limit of their own, each with the reason it is tolerated. The list may only shrink:
 * a new public route needs allow() from src/lib/rate.ts (CLAUDE.md).
 */
const PUBLIC_WITHOUT_LIMIT: Record<string, string> = {
  "POST /api/auth/logout": "ends only the caller's own session",
  "PUT /api/staging-access": "a bare 404 that reads and writes nothing",
  "PATCH /api/staging-access": "a bare 404 that reads and writes nothing",
  "DELETE /api/staging-access": "a bare 404 that reads and writes nothing",
};
/**
 * Signed-in writes that must carry a rate limit of their own (allow() from src/lib/rate.ts), on top of their gate: each
 * writes a log or record a script could churn. The list may only grow.
 */
const SESSION_RATE_LIMITED = ["POST /api/chat/feedback", "POST /api/governance/rollback", "POST /api/handoffs/[id]/decline", "PUT /api/models",
  // Agent instructions (rules 930-959).
  "PUT /api/instructions", "POST /api/instructions/activate", "POST /api/instructions/refs/search", "POST /api/instructions/refs/import", "POST /api/instructions/discard", "POST /api/instructions/restore", "POST /api/instructions/proposals/[id]", "POST /api/instructions/test",
  // Core-file rewrite cards (rule 2306).
  "POST /api/files/proposals/[id]",
  // UI/UX phase 3 (rules 1145, 1150, 1155); the status poll is a read, limited all the same.
  "POST /api/account/sessions", "PUT /api/notifications/prefs", "GET /api/billing/status",
  // The digest email choice (rule 2355).
  "PUT /api/notifications/digest",
  // Phone notifications (rules 2562-2567): per-login hourly buckets.
  "POST /api/push", "DELETE /api/push", "POST /api/push/seen", "GET /api/push/latest",
  // Chat spend cards (rule 1512): each Run is a paid batch or render.
  "POST /api/chat/spend/[id]",
  // Cloud drives and the media library (rule 1785): every write has its own hourly bucket per workspace.
  "POST /api/drives", "DELETE /api/drives", "POST /api/media/upload"];
/** Founder-console handlers that act only on the caller's own cookies, so they check no founder identity. */
const CONSOLE_SELF: Record<string, string> = {
  "POST /api/admin/login": "the console key in the body is the credential (compared with sameSecret, rate limited); it opens a server-side key session (15 minutes idle, 12 hours at most)",
  "DELETE /api/admin/login": "ends the caller's own key session: deletes the server record and the cookie",
  "POST /api/admin/impersonate": "stop: burns the impersonation session and restores the caller's own saved one",
  "DELETE /api/admin/staff/login": "staff sign-out: deletes the caller's own staff session record and both staff cookies",
  "POST /api/admin/staff/me": "the caller's own staff credentials only, read from the caller's staff session, with a fresh code from the caller's own authenticator",
};

const APP = join("src", "app");
/** Next serves a route handler from any route.{ts,tsx,js,jsx,mjs} anywhere under src/app, not only under src/app/api. */
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs)$/;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : ROUTE_FILE.test(f) ? [p] : []; });
const routeOf = (file: string) => "/" + relative(APP, file).split(sep).slice(0, -1).join("/");
const METHODS = "GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE";
/** Next finds a handler by name on the module (`handlers[method]`), so every declaration form counts. */
const HANDLER = new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|const|let|var)\\s+(${METHODS})\\b`, "gm");
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
type Handler = { key: string; method: string; file: string; body: string; shared: string };

/** Where a top-level declaration ends: its closing line at column 0 (`}` or `};`), or its own line for a one-liner. */
function endOf(source: string, start: number): number {
  const lineEnd = source.indexOf("\n", start);
  if (lineEnd < 0) return source.length;
  const next = /^\S.*$/gm;
  next.lastIndex = lineEnd + 1;
  const m = next.exec(source);
  if (!m) return source.length;
  return m[0].startsWith("}") ? m.index + m[0].length : m.index;
}
/**
 * The handlers of one module. `body` is the handler's own text only; `shared` is the module-level code that belongs to
 * no handler (an action map, a helper), where an action any handler checks may be named.
 */
function parse(file: string, source: string): Handler[] {
  const found = [...source.matchAll(HANDLER)].map((m) => ({ m, end: endOf(source, m.index!) }));
  let shared = "";
  let at = 0;
  for (const f of found) { shared += source.slice(at, f.m.index!); at = f.end; }
  shared += source.slice(at);
  return found.map(({ m, end }) => ({ key: `${m[1]} ${routeOf(file)}`, method: m[1], file, body: source.slice(m.index!, end), shared }));
}
const handlers = (): Handler[] => walk(APP).flatMap((file) => parse(file, readFileSync(file, "utf8")));
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
/** A refusal that is RETURNED: `const no = forbid(u, …); if (no) return no;` or `if (!can(u, …)) return …`. A bare call proves nothing. */
const RETURNED_GUARD = /const\s+(\w+)\s*=\s*forbid\([^;]*\);\s*if\s*\(\s*\1\s*\)\s*return\s+\1\b|if\s*\(\s*!can\([^;]*?\)\s*\)\s*return\b/;
const WRITES = /\bdb\.(?:set|del|lpush|ltrim|lrem|sadd|srem|hset|hdel|incrby|lock)\(|\bsave[A-Z]\w*\(|\bcreateSession\(/;
/**
 * A handler built with `handler(options, fn)` from src/lib/api-handler.ts (rule 1906): the options object, read from the
 * call's first argument. The wrapper runs `currentUser()` for auth "user", `isAdmin(req)` for "admin", the `sameSecret`
 * bearer for "cron", returns `forbid(u, role)` and counts `rate` with `allow`, in that order; tests/api-handler.test.ts
 * proves each against the wrapper itself. So `auth: "user"` stands for a session read, `role: "<action>"` for a returned
 * refusal of that action, and `rate:` for an `allow` call.
 */
const WRAPPED = /=\s*handler(?:<[^>]*>)?\(\s*\{([\s\S]*?)\}\s*,\s*async\b/;
const wrapped = (h: Handler) => {
  const opts = WRAPPED.exec(h.body)?.[1];
  return opts === undefined ? null : { auth: /\bauth:\s*"(\w+)"/.exec(opts)?.[1], role: /\brole:\s*"[\w.]+"/.test(opts), rate: /\brate:\s*\{/.test(opts) };
};

/** What is wrong with one handler against its declared gate; empty when it holds. */
function violations(h: Handler, gate: Gate): string[] {
  const out: string[] = [];
  const w = wrapped(h);
  if (gate === "public") {
    if (!/\ballow\(/.test(h.body) && !w?.rate && !PUBLIC_WITHOUT_LIMIT[h.key]) out.push("public write without a rate limit (allow)");
    return out;
  }
  if (gate === "public-read") {
    if (!READ_METHODS.has(h.method)) out.push("only a GET, HEAD or OPTIONS can be public-read");
    if (WRITES.test(h.body)) out.push("public-read handler writes state");
    return out;
  }
  if (gate === "cron") return /sameSecret\(/.test(h.body) || w?.auth === "cron" ? [] : ["cron handler without the sameSecret bearer check"];
  if (gate === "unverified-session") return /\bcurrentUserUnverified\(/.test(h.body) && /\b(?:allow|verifySendRefusal)\(/.test(h.body) ? [] : ["verify handler without currentUserUnverified and allow (or verifySendRefusal)"];
  if (gate === "bearer") return /userFromBearer\(/.test(h.body) ? [] : ["bearer handler without userFromBearer"];
  if (gate === "admin-console") return /\b(?:isAdmin|adminActor)\(/.test(h.body) || w?.auth === "admin" || CONSOLE_SELF[h.key] ? [] : ["console handler without isAdmin/adminActor"];
  if (!/\bcurrentUser\(/.test(h.body) && w?.auth !== "user") out.push("no session read (currentUser)");
  if (gate === "member") return out;
  if (!RETURNED_GUARD.test(h.body) && !w?.role) out.push(`declared ${gate.role} but the handler never returns the refusal of forbid() or can()`);
  for (const a of gate.actions) {
    if (!Object.prototype.hasOwnProperty.call(MIN_ROLE, a)) out.push(`unknown action ${a}`);
    // In THIS handler (or module-level code no handler owns): a sibling handler naming the action proves nothing.
    else if (!h.body.includes(`"${a}"`) && !h.shared.includes(`"${a}"`)) out.push(`action "${a}" is declared but this handler never checks it`);
  }
  const top = Math.max(...gate.actions.map((a) => RANK[MIN_ROLE[a] as Role] ?? 0));
  if (gate.actions.length && top !== RANK[gate.role]) out.push(`declared ${gate.role} but its actions need at most ${Object.keys(RANK).find((r) => RANK[r as Role] === top)}`);
  return out;
}

describe("every API handler has a declared gate (fail closed)", () => {
  const all = handlers();
  const declared = (h: Handler) => (READ_METHODS.has(h.method) ? READS[h.key] : ROUTE_ROLES[h.key]);

  it("finds the handlers at all (the walk and the pattern still match the code)", () => {
    expect(all.filter((h) => !READ_METHODS.has(h.method)).length).toBeGreaterThan(40);
    expect(all.filter((h) => READ_METHODS.has(h.method)).length).toBeGreaterThan(40);
    expect(all.map((h) => h.key)).toEqual(expect.arrayContaining(["PUT /api/governance", "GET /api/cron/daily", "OPTIONS /api/mcp"]));
  });
  it("no handler of any method is missing from the maps", () => {
    expect(all.filter((h) => !declared(h)).map((h) => `${h.key}  (${h.file})`)).toEqual([]);
  });
  it("no map entry names a handler that does not exist, and each map holds only its own methods", () => {
    const keys = new Set(all.map((h) => h.key));
    expect(Object.keys({ ...ROUTE_ROLES, ...READS }).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.keys(ROUTE_ROLES).filter((k) => READ_METHODS.has(k.split(" ")[0]))).toEqual([]);
    expect(Object.keys(READS).filter((k) => !READ_METHODS.has(k.split(" ")[0]))).toEqual([]);
  });
  it("no route re-exports a handler in a shape the walk cannot see", () => {
    const hidden = walk(APP).filter((f) => new RegExp(`export\\s*\\{[^}]*\\b(?:${METHODS})\\b[^}]*\\}`).test(readFileSync(f, "utf8")));
    expect(hidden).toEqual([]);
  });
  it("each handler checks what its declared gate needs", () => {
    const bad = all.flatMap((h) => { const gate = declared(h); return gate ? violations(h, gate).map((v) => `${h.key}: ${v}`) : []; });
    expect(bad).toEqual([]);
  });
  it("every signed-in write listed as rate limited calls allow() (rule 378)", () => {
    for (const k of SESSION_RATE_LIMITED) {
      const h = all.find((x) => x.key === k);
      expect(h, `${k} exists`).toBeTruthy();
      if (!wrapped(h!)?.rate) expect(h!.body, k).toMatch(/\ballow\(/);
    }
  });
  it("the lists of tolerated exceptions only name public or console handlers", () => {
    for (const k of Object.keys(PUBLIC_WITHOUT_LIMIT)) expect(ROUTE_ROLES[k], k).toBe("public");
    for (const k of Object.keys(CONSOLE_SELF)) expect(ROUTE_ROLES[k], k).toBe("admin-console");
  });
  it("the checker itself catches the shapes that used to pass: let/var handlers, a sibling's action, a discarded refusal", () => {
    const file = join(APP, "api", "probe", "route.ts");
    const source = [
      'const MAP = { x: "connectors" };',
      "export async function GET() {",
      "  const u = await currentUser();",
      '  const no = forbid(u, "read");',
      "  if (no) return no;",
      "}",
      "export async function POST() {",
      "  const u = await currentUser();",
      '  const no = forbid(u, "referral");',
      "  if (no) return no;",
      "}",
      "export async function PUT() {",
      "  const u = await currentUser();",
      '  const no = forbid(u, "onboard");',
      "  return Response.json({ ok: true });",
      "}",
      "export let PATCH = async () => { return Response.json({}); };",
      "export var DELETE = async () => Response.json({});",
      "export function OPTIONS() { return new Response(null); }",
    ].join("\n");
    const hs = Object.fromEntries(parse(file, source).map((h) => [h.method, h]));
    expect(Object.keys(hs).sort()).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]);
    expect(hs.GET.key).toBe("GET /api/probe");
    expect(violations(hs.GET, g("owner", "referral"))).toEqual([expect.stringContaining('"referral"')]);
    expect(violations(hs.POST, g("owner", "referral"))).toEqual([]);
    expect(violations(hs.PUT, g("admin", "onboard"))).toEqual([expect.stringContaining("never returns the refusal")]);
    expect(violations(hs.GET, g("admin", "connectors")), "an action named in module-level code no handler owns counts").toEqual([]);
    expect(violations(hs.OPTIONS, "public-read")).toEqual([]);
    expect(violations(hs.PATCH, "public-read")).toEqual(["only a GET, HEAD or OPTIONS can be public-read"]);
  });
  it("rule 1906: the checker reads a wrapped handler's options, and only those", () => {
    const file = join(APP, "api", "probe", "route.ts");
    const source = [
      "const body = z.object({ x: z.string() });",
      'export const GET = handler({ auth: "user", role: "read" }, async ({ scope }) => {',
      "  return Response.json({ scope });",
      "});",
      'export const POST = handler({ auth: "user", rate: { bucket: "p", max: 1, window: WINDOW.hour }, input: body }, async () => Response.json({}));',
      'export const PUT = handler({ auth: "user" }, async () => Response.json({}));',
      'export const PATCH = handler({ auth: "public" }, async () => Response.json({ note: "auth: \\"user\\"" }));',
      'export const DELETE = handler({ auth: "cron" }, async () => Response.json({}));',
    ].join("\n");
    const hs = Object.fromEntries(parse(file, source).map((h) => [h.method, h]));
    expect(Object.keys(hs).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
    expect(violations(hs.GET, g("member", "read"))).toEqual([]);
    // The wrapper's role is "read", so a gate that needs "brand.write" is not proven by it.
    expect(violations(hs.GET, g("admin", "brand.write"))).toEqual([expect.stringContaining('"brand.write"')]);
    expect(violations(hs.POST, "member")).toEqual([]);
    expect(violations(hs.PUT, g("member", "read")), "no role option, no forbid").toEqual([expect.stringContaining("never returns the refusal"), expect.stringContaining('"read"')]);
    // A public handler is not a session read, whatever its body says; and it has no rate limit.
    expect(violations(hs.PATCH, "member")).toEqual(["no session read (currentUser)"]);
    expect(violations(hs.PATCH, "public")).toEqual(["public write without a rate limit (allow)"]);
    expect(violations(hs.DELETE, "cron")).toEqual([]);
    expect(violations(hs.PUT, "cron")).toEqual(["cron handler without the sameSecret bearer check"]);
    // What the checker trusts the wrapper to do, it does: the calls are in src/lib/api-handler.ts.
    const lib = readFileSync(join("src", "lib", "api-handler.ts"), "utf8");
    for (const call of ["currentUser()", "isAdmin(req)", "sameSecret(bearer, process.env.CRON_SECRET)", "forbid(u, opts.role)", "allow(`${r.bucket}:${who}`"]) expect(lib).toContain(call);
  });
});

describe("request users never stand in for the acting login", () => {
  /**
   * `u` in a route is the ACCOUNT (the owner's record) even for a member. Checking a password against it, minting a
   * token for it or asking whether it is the founder answers for the owner, not for the person acting.
   */
  const BANNED = [/\bverifyPassword\(\s*u\s*,/, /\bcreateMcpToken\(\s*u\.email\b/, /\bisFounder\(\s*u\.email\b/];
  it("no API route checks a password, mints a token or tests founder status on the account record", () => {
    const bad = walk(APP).flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (BANNED.some((re) => re.test(line)) ? [`${f}:${i + 1}: ${line.trim()}`] : [])));
    expect(bad).toEqual([]);
  });
});

describe("the gates that live outside the route table", () => {
  it("the chat tools that change the brand, publish or import the catalog carry the route's own action", () => {
    expect(CHAT_TOOL_ACTION).toEqual({ update_brand: "brand.write", publish_item: "publish", import_catalog: "catalog.import", propose_meeting_tasks: "todo.write" });
    // The brand, publish and import tools are the owner's and an admin's; Reem's meeting follow-up (rule 607) is the to-do list's, open to every login.
    for (const [t, a] of Object.entries(CHAT_TOOL_ACTION)) expect(MIN_ROLE[a], t).toBe(t === "propose_meeting_tasks" ? "member" : "admin");
  });
  it("every MCP tool is mapped to an action, and nothing else is", async () => {
    const listed = ((await (await mcpRoute.GET()).json()) as { tools: string[] }).tools;
    expect(Object.keys(MCP_TOOL_ACTION).sort()).toEqual([...listed].sort());
    for (const a of Object.values(MCP_TOOL_ACTION)) expect(Object.prototype.hasOwnProperty.call(MIN_ROLE, a)).toBe(true);
  });
  it("the core files a member may not delete are exactly the ones every agent reads (files.ts memoryBlock)", () => {
    const src = readFileSync(join("src", "lib", "files.ts"), "utf8");
    const wanted = src.match(/const wanted = \[([^\]]+)\]/)?.[1];
    expect(wanted).toBeTruthy();
    expect([...CORE_FILES].sort()).toEqual([...wanted!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
  });
});

// ── Part two: real sessions against the real handlers ────────────────────────────────────────────────────────────────

const BRAND: Brand = { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29" };
const brandBody = { name: "Changed", industry: "coffee", products: "beans", audience: "everyone" };
const task = (id: string, status: Task["status"], body = "قهوة طازجة"): Task => ({ id, type: "social", channel: "instagram", title: id, body, status, createdAt: new Date().toISOString(), lang: "ar" });
const ctx = <T extends Record<string, string>>(p: T) => params(p);

/** An account with a brand, one plain member and one admin. */
async function team(fx: Fixture = {}) {
  const owner = await newUser("rg", fx);
  await saveBrand(owner.email, BRAND);
  const member = await newMember(owner, "member", "rgm", fx);
  const admin = await newMember(owner, "admin", "rga", fx);
  return { owner, member: member.email, admin: admin.email };
}
/** Sign in as this login and return what a request resolves to. */
async function as(email: string, opts: { imp?: string } = {}): Promise<User> {
  await signIn(email, opts);
  const u = await currentUser();
  expect(u, `session for ${email}`).not.toBeNull();
  return u!;
}
const status = async (p: Promise<Response>) => (await p).status;

beforeEach(() => { signOut(); published.length = 0; });

describe("a plain member is refused every owner and admin route, and nothing changes", () => {
  it("governance, MCP token, publish, brand, schedule and connector start answer 403", async () => {
    const { owner, member } = await team();
    await saveTask(owner.email, task("t1", "approved"), true);
    await saveConnection(owner.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    const [gov, sched] = await Promise.all([getGov(owner.email), getSchedule(owner.email)]);
    await as(member);

    expect(await status(governanceRoute.PUT(json("/api/governance", "PUT", { autoApprove: { social: true }, learning: false })))).toBe(403);
    expect(await status(tokenRoute.POST())).toBe(403);
    expect(await status(publishRoute.POST(await vjson("/api/publish/t1", "POST", { provider: "telegram" }), ctx({ id: "t1" })))).toBe(403);
    expect(await status(brandRoute.PUT(json("/api/brand", "PUT", brandBody)))).toBe(403);
    expect(await status(scheduleRoute.PUT(json("/api/schedule", "PUT", { weeklyPlan: false, routines: {} })))).toBe(403);
    expect(await status(startRoute.GET(new Request("https://nashr.test/api/connect/x/start?lang=en"), ctx({ provider: "x" })))).toBe(403);

    expect(await getGov(owner.email)).toEqual(gov);
    expect(await getSchedule(owner.email)).toEqual(sched);
    expect(await Promise.all([getMcpToken(owner.email), getMcpToken(member)])).toEqual([null, null]);
    expect(published).toEqual([]);
    expect((await getBrand(owner.email))!.name).toBe(BRAND.name);
  });

  it("the rest of the owner and admin surface answers 403 too", async () => {
    const { owner, member } = await team();
    await writeFile(owner.email, "brand.md", "# brand", "user");
    await saveConnection(owner.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await as(member);
    const form = (fields: Record<string, string>) => new Request("https://nashr.test/api/oauth/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

    expect(await status(tokenRoute.GET())).toBe(403);
    expect(await status(tokenRoute.DELETE())).toBe(403);
    expect(await status(grantsRoute.GET())).toBe(403);
    expect(await status(grantsRoute.DELETE(new Request("https://nashr.test/api/mcp/grants?all=1", { method: "DELETE" })))).toBe(403);
    expect(await status(approveRoute.POST(form({ client_id: "c", redirect_uri: "https://x.example/cb", decision: "allow", code_challenge: "abc", code_challenge_method: "S256" })))).toBe(403);
    expect(await status(referralRoute.GET())).toBe(403);
    expect(await status(shareRoute.POST(json("/api/referral/share", "POST", { platform: "x" })))).toBe(403);
    expect(await status(brandsRoute.POST(json("/api/brands", "POST", { action: "add", name: "Side" })))).toBe(403);
    expect(await status(onboardConfirm.POST(json("/api/onboard/confirm", "POST", { url: "roastery.example" })))).toBe(403);
    expect(await status(catalogRoute.POST(json("/api/catalog", "POST", { url: "https://roastery.example" })))).toBe(403);
    expect(await status(connRoute.DELETE(new Request("https://nashr.test/api/connect/telegram", { method: "DELETE" }), ctx({ provider: "telegram" })))).toBe(403);
    expect(await status(connRoute.POST(json("/api/connect/meta", "POST", { action: "select_page", pageId: "1" }), ctx({ provider: "meta" })))).toBe(403);
    expect(await status(keyRoute.POST(json("/api/connect/telegram/key", "POST", { token: "t", chatId: "c" }), ctx({ provider: "telegram" })))).toBe(403);
    expect(await status(perfRoute.DELETE())).toBe(403);
    expect(await status(filesRoute.DELETE(new Request("https://nashr.test/api/files?name=Brand.MD", { method: "DELETE" })))).toBe(403);

    expect(await getConnection(owner.email, "telegram")).not.toBeNull();
    expect(await readFile(owner.email, "brand.md")).not.toBeNull();
  });

  it("core memory, performance data, onboarding and the share bonus data answer 403 as well, and nothing changes", async () => {
    const { owner, member } = await team();
    await writeFile(owner.email, "brand.md", "# brand", "user");
    await writeFile(owner.email, "products.md", "# imported catalog", "noor");
    await db.set(`perfimport:${owner.email}`, { marker: "the admin's import" });
    await db.set(`onboardplan:${owner.email}`, { goal: "g", plan: [{ title: "t" }] });
    await as(member);
    // Writing a core file empty is deleting it (memoryBlock skips empty files), so it needs what DELETE needs.
    expect(await status(filesRoute.PUT(json("/api/files", "PUT", { name: "brand.md", content: "" })))).toBe(403);
    expect(await status(filesRoute.PUT(json("/api/files", "PUT", { name: "Products.MD", content: "made up" })))).toBe(403);
    // Replacing the imported performance data deletes it: a member may neither.
    expect(await status(perfRoute.POST(json("/api/performance", "POST", { csv: "Campaign name,Amount spent (SAR)\nx,1" })))).toBe(403);
    expect(await status(onboardRoute.POST(json("/api/onboard", "POST", { url: "roastery.example" })))).toBe(403);
    expect(await status(onboardPlanRoute.POST(json("/api/onboard/plan", "POST", { index: 0, added: true })))).toBe(403);
    expect(await status(shareRoute.GET())).toBe(403);

    expect((await readFile(owner.email, "brand.md"))!.content).toBe("# brand");
    expect((await readFile(owner.email, "products.md"))!.content).toBe("# imported catalog");
    expect(await db.get(`perfimport:${owner.email}`)).toEqual({ marker: "the admin's import" });
    expect(await db.get(`onboardplan:${owner.email}`)).toEqual({ goal: "g", plan: [{ title: "t" }] });
  });

  it("keeps what every member may do: a draft edit, a rejection, a non-core file, a connector sync", async () => {
    const { owner, member } = await team();
    await saveTask(owner.email, task("d1", "pending"), true);
    await saveTask(owner.email, task("d2", "pending"), true);
    await writeFile(owner.email, "notes.md", "mine", "user");
    await as(member);
    expect(await status(filesRoute.PUT(json("/api/files", "PUT", { name: "ideas.md", content: "a member's own notes" })))).toBe(200);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/d1", "PATCH", { editedBody: "قهوة مختصة" }), ctx({ id: "d1" })))).toBe(200);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/d2", "PATCH", { status: "rejected", note: "no" }), ctx({ id: "d2" })))).toBe(200);
    expect(await status(filesRoute.DELETE(new Request("https://nashr.test/api/files?name=notes.md", { method: "DELETE" })))).toBe(200);
    // A sync is not refused for the role: it gets as far as looking for the connection.
    expect(await status(connRoute.POST(json("/api/connect/shopify", "POST", { action: "sync_sales" }), ctx({ provider: "shopify" })))).toBe(404);
    expect((await getTask(owner.email, "d1"))!.editedBody).toBe("قهوة مختصة");
    expect((await getTask(owner.email, "d2"))!.status).toBe("rejected");
    expect(await readFile(owner.email, "notes.md")).toBeNull();
  });
});

describe("approval is admin and owner only, in the inbox as on the publish button", () => {
  it("a member cannot approve, nor rewrite an item that stays approved; an admin can approve", async () => {
    const { owner, member, admin } = await team();
    await saveTask(owner.email, task("p1", "pending"), true);
    await saveTask(owner.email, task("a1", "approved"), true);
    await as(member);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/p1", "PATCH", { status: "approved" }), ctx({ id: "p1" })))).toBe(403);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/p1", "PATCH", { editedBody: "نص آخر", status: "approved" }), ctx({ id: "p1" })))).toBe(403);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/a1", "PATCH", { editedBody: "نص لم يوافق عليه أحد" }), ctx({ id: "a1" })))).toBe(403);
    expect(await getTask(owner.email, "p1")).toMatchObject({ status: "pending", body: "قهوة طازجة" });
    expect((await getTask(owner.email, "a1"))!.editedBody).toBeUndefined();
    // Taking an approval back is not an approval: a member may reopen it, and that puts it back in front of an admin.
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/a1", "PATCH", { status: "pending" }), ctx({ id: "a1" })))).toBe(200);

    await as(admin);
    expect(await status(taskRoute.PATCH(await vjson("/api/tasks/p1", "PATCH", { status: "approved" }), ctx({ id: "p1" })))).toBe(200);
    expect((await getTask(owner.email, "p1"))!.status).toBe("approved");
  });
});

describe("a governance restore is a governance write; the activity log is a read (rules 227 and 237)", () => {
  it("a member and an admin are refused a restore before anything is read, and nothing changes; the owner may", async () => {
    const { owner, member, admin } = await team();
    const saved = await saveGovAs(owner.email, { reviewer: false }, { kind: "owner", email: owner.email });
    if (!saved.ok || !saved.revision) throw new Error("not saved");
    const id = saved.revision.id;
    const [gov, hist] = await Promise.all([getGov(owner.email), listGovHistory(owner.email)]);
    const restore = () => rollbackRoute.POST(json("/api/governance/rollback", "POST", { id }));
    for (const login of [member, admin]) {
      await as(login);
      const lrange = vi.spyOn(db, "lrange");
      expect(await status(restore()), login).toBe(403);
      expect(lrange, "refused before the history is read").not.toHaveBeenCalled();
      lrange.mockRestore();
    }
    expect(await getGov(owner.email)).toEqual(gov);
    expect(await listGovHistory(owner.email)).toEqual(hist);
    await as(owner.email);
    expect(await status(restore())).toBe(200);
    expect((await getGov(owner.email)).reviewer).toBe(true);
  });

  it("every member reads the account's activity log and its export, and only that account's", async () => {
    const { owner, member } = await team();
    await recordActivity(owner.email, [{ at: new Date().toISOString(), kind: "published", by: { kind: "owner", email: owner.email }, via: "app", note: "the owner's post" }]);
    await as(member);
    const page = await activityRoute.GET(json("/api/activity", "GET"));
    expect(page.status).toBe(200);
    expect(((await page.json()) as { rows: { note?: string }[] }).rows.map((r) => r.note)).toEqual(["the owner's post"]);
    const csv = await activityExportRoute.GET(new Request("http://t/api/activity/export"));
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("the owner's post");
    signOut();
    expect(await status(activityExportRoute.GET(new Request("http://t/api/activity/export")))).toBe(401);
  });
});

describe("an admin runs the workspace but not the account", () => {
  it("is refused governance and the MCP token, and may write the brand, the schedule and core files", async () => {
    const { owner, admin } = await team();
    await writeFile(owner.email, "brand.md", "# brand", "user");
    await as(admin);
    expect(await status(governanceRoute.PUT(json("/api/governance", "PUT", { learning: false })))).toBe(403);
    expect(await status(tokenRoute.POST())).toBe(403);
    expect(await status(referralRoute.GET())).toBe(403);
    expect(await status(brandRoute.PUT(json("/api/brand", "PUT", brandBody)))).toBe(200);
    expect((await getBrand(owner.email))!.name).toBe("Changed");
    expect(await status(scheduleRoute.PUT(json("/api/schedule", "PUT", { weeklyPlan: false })))).toBe(200);
    expect((await getSchedule(owner.email)).weeklyPlan).toBe(false);
    expect(await status(filesRoute.PUT(json("/api/files", "PUT", { name: "brand.md", content: "# brand, rewritten" })))).toBe(200);
    expect((await readFile(owner.email, "brand.md"))!.content).toBe("# brand, rewritten");
    expect(await status(filesRoute.DELETE(new Request("https://nashr.test/api/files?name=brand.md", { method: "DELETE" })))).toBe(200);
    expect(await readFile(owner.email, "brand.md")).toBeNull();
  });
  it("the owner still passes the owner gates", async () => {
    const { owner } = await team();
    await as(owner.email);
    expect(await status(governanceRoute.PUT(json("/api/governance", "PUT", { learning: false })))).toBe(200);
    expect((await getGov(owner.email)).learning).toBe(false);
    const minted = (await (await tokenRoute.POST()).json()) as { token: string };
    expect(minted.token).toMatch(/^thakeen_/);
    expect(await getMcpToken(owner.email)).toBe(tokenHash(minted.token)); // stored hashed, never raw (rules 548-555)
  });
});

describe("a founder impersonating an account cannot mint lasting credentials", () => {
  it("refuses the MCP token and OAuth approval while impersonating", async () => {
    const { owner } = await team();
    await as(owner.email, { imp: "founder@nashr.test" });
    expect(await status(tokenRoute.POST())).toBe(403);
    const form = new Request("https://nashr.test/api/oauth/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=c&redirect_uri=https%3A%2F%2Fx.example%2Fcb&decision=allow" });
    expect(await status(approveRoute.POST(form))).toBe(403);
    expect(await getMcpToken(owner.email)).toBeNull();
  });
});

describe("asking Noor is not a way around a gate (chat runTool)", () => {
  it("a member's update_brand, publish_item and import_catalog are refused in code and change nothing", async () => {
    const { owner, member } = await team();
    await saveConnection(owner.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(owner.email, task("ok1", "approved"), true);
    const u = await as(member);
    const actions: string[] = [];
    expect(await runTool(u, "update_brand", { field: "banned", value: "" }, actions)).toMatch(/^Not done: update_brand needs the owner or an admin/);
    expect(await runTool(u, "publish_item", { task_id: "ok1", provider: "telegram" }, actions)).toMatch(/^Not done: publish_item/);
    expect(await runTool(u, "import_catalog", { url: "https://roastery.example" }, actions)).toMatch(/^Not done: import_catalog/);
    expect((await getBrand(owner.email))!.banned).toBe("رخيص");
    expect(published).toEqual([]);
    expect(actions).toEqual([]);
    // Core memory through the chat is the same gate as PUT /api/files: an agent write is no way around it.
    await writeFile(owner.email, "products.md", "# imported catalog", "noor");
    expect(await runTool(u, "write_file", { name: "Products.MD", content: "" }, actions)).toMatch(/^Not done: products\.md is core memory/);
    expect(await runTool(u, "write_file", { name: "brand.md", content: "cheap is fine" }, actions)).toMatch(/^Not done: brand\.md/);
    expect((await readFile(owner.email, "products.md"))!.content).toBe("# imported catalog");
    expect(await readFile(owner.email, "brand.md")).toBeNull();
    expect(actions).toEqual([]);
    // The tools every member keeps still run, a non-core file included.
    expect(await runTool(u, "list_inbox", {}, actions)).toMatch(/Inbox:/);
    expect(await runTool(u, "write_file", { name: "campaign-ideas.md", content: "ideas" }, actions)).toMatch(/^Saved campaign-ideas\.md/);
  });
  it("an admin and the owner may, and a user resolved with no actor may not (fail closed)", async () => {
    const { owner, admin } = await team();
    // May propose (rule 568): no tool call writes the brand file, an admin's and the owner's included.
    expect(await runTool(await as(admin), "update_brand", { field: "tone", value: "رسمي" }, [])).toMatch(/^Not saved yet: brand\.tone/);
    expect(await runTool(await as(owner.email), "update_brand", { field: "city", value: "جدة" }, [])).toMatch(/^Not saved yet: brand\.city/);
    expect(await runTool(await as(admin), "write_file", { name: "strategy.md", content: "# strategy" }, [])).toMatch(/^Saved strategy\.md/);
    const bare = { ...owner, actor: undefined };
    expect(await runTool(bare, "update_brand", { field: "tone", value: "x" }, [])).toMatch(/^Not done/);
    expect((await getBrand(owner.email))!.tone).not.toBe("رسمي");
    expect((await getBrand(owner.email))!.city).not.toBe("جدة");
  });
});

describe("MCP dispatch uses the same table", () => {
  const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
    mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  it("an owner token (actor kind token, role owner) passes; an unknown tool is refused before anything runs", async () => {
    const { owner } = await team();
    await writeFile(owner.email, "notes.md", "hello", "user");
    const token = await createMcpToken(owner.email);
    const listed = (await (await call(token, "list_files")).json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    expect(listed.result?.isError).toBeUndefined();
    expect(listed.result?.content[0].text).toMatch(/notes\.md/);
    const unknown = (await (await call(token, "delete_everything")).json()) as { error?: { code: number } };
    expect(unknown.error?.code).toBe(-32602);
  });
});

describe("the active brand is per login", () => {
  it("a member switching brand moves only their own active brand, and works in the owner's workspace", async () => {
    const { owner, member } = await team();
    await saveUser({ ...(await getUser(owner.email))!, plan: "agency" });
    await as(owner.email);
    const added = (await (await brandsRoute.POST(json("/api/brands", "POST", { action: "add", name: "Second" }))).json()) as { brand: { id: string } };
    await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "default" }));
    expect(await readActiveBrand(owner.email)).toBe("default");

    const u = await as(member);
    expect(await status(brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: added.brand.id })))).toBe(200);
    expect(await readActiveBrand(member)).toBe(added.brand.id);
    expect(await readActiveBrand(owner.email)).toBe("default");
    expect(u.email).toBe(owner.email);
    expect((await as(member)).scope).toBe(`${owner.email}#${added.brand.id}`);
    expect((await as(owner.email)).scope).toBe(owner.email);
  });
  it("an admin archiving the brand the owner is on sends the owner back to the default brand", async () => {
    const { owner, admin } = await team();
    await saveUser({ ...(await getUser(owner.email))!, plan: "agency" });
    await as(owner.email);
    const added = (await (await brandsRoute.POST(json("/api/brands", "POST", { action: "add", name: "Second" }))).json()) as { brand: { id: string } };
    expect(await readActiveBrand(owner.email)).toBe(added.brand.id);
    await as(admin);
    expect(await status(brandsRoute.POST(json("/api/brands", "POST", { action: "archive", id: added.brand.id })))).toBe(200);
    expect(await readActiveBrand(owner.email)).toBe("default");
  });
});

describe("a connector flow is finished by the login that started it, with the role to do it", () => {
  const errorOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("error");
  it("refuses a state started by another login of the same account, and a login that lost the role", async () => {
    const { owner, member, admin } = await team();
    await saveState("rg-s1", { email: owner.email, provider: "x", lang: "en", shop: "", verifier: "v", actor: admin });
    await signIn(owner.email);
    jar().set(OAUTH_COOKIE, "rg-s1");
    expect(errorOf(await callbackRoute.GET(new Request("https://nashr.test/api/connect/x/callback?state=rg-s1&code=c"), ctx({ provider: "x" })))).toBe("session_mismatch");

    // A state from before the actor was recorded names only the account: it completes for nobody but the owner.
    await saveState("rg-s2", { email: owner.email, provider: "x", lang: "en", shop: "", verifier: "v" });
    await signIn(admin);
    jar().set(OAUTH_COOKIE, "rg-s2");
    expect(errorOf(await callbackRoute.GET(new Request("https://nashr.test/api/connect/x/callback?state=rg-s2&code=c"), ctx({ provider: "x" })))).toBe("session_mismatch");

    await saveState("rg-s3", { email: owner.email, provider: "x", lang: "en", shop: "", verifier: "v", actor: member });
    await signIn(member);
    jar().set(OAUTH_COOKIE, "rg-s3");
    expect(errorOf(await callbackRoute.GET(new Request("https://nashr.test/api/connect/x/callback?state=rg-s3&code=c"), ctx({ provider: "x" })))).toBe("forbidden");
    expect(await getConnection(owner.email, "x")).toBeNull();
  });
});
