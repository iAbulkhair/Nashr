import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 2033-2034: the ratchet on raw Redis key templates (src/lib/keys.ts header).
 *
 * A raw key template is a template literal that opens with a key prefix and a placeholder (`brand:${...}`,
 * `lock:team:${...}`). Outside src/lib/keys.ts each file may hold at most the count listed below, and the count may
 * only go down: a file not listed holds none, a file above its count fails, and a file below its count fails until the
 * number here is lowered to match (so the list never hides room for a new raw key). A few matches are not Redis keys
 * (log labels, fingerprints); they count the same and leave when their file adopts the registry.
 *
 * `scopeParam` (a lib helper's string scope turned into a `Scope`) and `storedScope` (a scope read back from our own
 * records) follow the same ratchet, and no route or page under src/app calls either: requests reach keys through `sc(u)`.
 *
 * Files the wave 2a split creates out of src/lib/secretary*.ts, src/lib/chat.ts and src/lib/app-i18n.ts inherit their
 * parent's raw keys: move the parent's count onto the new files when that branch lands (the total may not grow).
 */

const RAW = /`[a-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*:\$\{/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const FILES = sources("src").filter((f) => f !== join("src", "lib", "keys.ts")).sort();
const count = (re: RegExp) => Object.fromEntries(FILES.map((f) => [f, (readFileSync(f, "utf8").match(re) ?? []).length] as const).filter(([, n]) => n > 0));

function ratchet(name: string, found: Record<string, number>, allowed: Record<string, number>) {
  const problems: string[] = [];
  for (const [f, n] of Object.entries(found)) {
    const max = allowed[f] ?? 0;
    if (n > max) problems.push(`${f}: ${n} ${name}, allowed ${max}. Build the key with src/lib/keys.ts.`);
  }
  for (const [f, max] of Object.entries(allowed)) {
    const n = found[f] ?? 0;
    if (n < max) problems.push(`${f}: ${n} ${name}, list says ${max}. Lower the number in tests/key-registry-ratchet.test.ts.`);
  }
  return problems;
}
const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe("rule 2034: raw Redis key templates outside the registry only go down", () => {
  it("each file holds at most its listed count, and the list matches the tree", () => {
    expect(ratchet("raw key templates", count(RAW), RAW_KEYS)).toEqual([]);
  });
  it("the total is at or under the number recorded when the registry landed (801 before adoption)", () => {
    expect(total(RAW_KEYS)).toBeLessThanOrEqual(524);
  });
  it("the pattern catches the forms the registry replaced and skips the builders", () => {
    const hit = (s: string) => (s.match(RAW) ?? []).length;
    expect(hit("db.get(`brand:${scope}`)")).toBe(1);
    expect(hit("db.get(`lock:team:${owner}`)")).toBe(1);
    expect(hit("db.get(`task:${s}:${id}`)")).toBe(1);
    expect(hit("db.get(wsKey.brand(sc(u)))")).toBe(0);
  });
});

describe("rule 2033: scopeParam and storedScope calls only go down, and never appear under src/app", () => {
  it("scopeParam", () => {
    expect(ratchet("scopeParam calls", count(/\bscopeParam\(/g), SCOPE_PARAM)).toEqual([]);
    expect(total(SCOPE_PARAM)).toBeLessThanOrEqual(90);
  });
  it("storedScope", () => {
    expect(ratchet("storedScope calls", count(/\bstoredScope\(/g), STORED_SCOPE)).toEqual([]);
  });
  it("storedPersonId and storedAccountId (rule 2137)", () => {
    expect(ratchet("storedPersonId calls", count(/\bstoredPersonId\(/g), STORED_PERSON_ID)).toEqual([]);
    expect(ratchet("storedAccountId calls", count(/\bstoredAccountId\(/g), STORED_ACCOUNT_ID)).toEqual([]);
  });
  it("no route or page converts a string into a person or an account id (rule 2137)", () => {
    const app = FILES.filter((f) => f.startsWith(join("src", "app")));
    const offenders = app.filter((f) => /\b(storedPersonId|storedAccountId)\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no route or page converts a string into a scope", () => {
    const app = FILES.filter((f) => f.startsWith(join("src", "app")));
    const offenders = app.filter((f) => /\b(scopeParam|storedScope|workspaceScope)\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

const RAW_KEYS: Record<string, number> = {
  "src/app/[lang]/app/settings/billing/page.tsx": 1,
  "src/app/api/account/2fa/route.ts": 1,
  "src/app/api/account/email/route.ts": 2,
  "src/app/api/account/export/route.ts": 2,
  "src/app/api/account/google/route.ts": 1,
  "src/app/api/account/sessions/route.ts": 2,
  "src/app/api/admin/agent-scope/route.ts": 2,
  "src/app/api/admin/impersonate/route.ts": 1,
  "src/app/api/admin/log/route.ts": 1,
  "src/app/api/admin/login/route.ts": 1,
  "src/app/api/admin/payments/[email]/route.ts": 2,
  "src/app/api/admin/plan/route.ts": 7,
  "src/app/api/admin/staff/login/code/route.ts": 1,
  "src/app/api/admin/staff/login/enrol/route.ts": 1,
  "src/app/api/admin/staff/login/route.ts": 1,
  "src/app/api/admin/staff/me/route.ts": 1,
  "src/app/api/admin/staff/route.ts": 1,
  "src/app/api/admin/staff/setup/route.ts": 1,
  "src/app/api/admin/topups/route.ts": 2,
  "src/app/api/admin/wishlist/route.ts": 1,
  "src/app/api/affiliates/route.ts": 1,
  "src/app/api/auth/forgot/route.ts": 3,
  "src/app/api/auth/google/callback/route.ts": 2,
  "src/app/api/auth/google/start/route.ts": 1,
  "src/app/api/auth/login/mfa/route.ts": 2,
  "src/app/api/auth/login/route.ts": 2,
  "src/app/api/auth/reset/route.ts": 3,
  "src/app/api/auth/signup/route.ts": 1,
  "src/app/api/auth/verify/check/route.ts": 1,
  "src/app/api/auth/verify/email/route.ts": 2,
  "src/app/api/billing/chat-overflow/route.ts": 1,
  "src/app/api/billing/checkout/route.ts": 1,
  "src/app/api/billing/paymob/webhook/route.ts": 1,
  "src/app/api/billing/renewal/route.ts": 1,
  "src/app/api/billing/status/route.ts": 1,
  "src/app/api/chat/feedback/route.ts": 1,
  "src/app/api/chat/spend/[id]/route.ts": 1,
  "src/app/api/connect/[provider]/route.ts": 8,
  "src/app/api/cron/daily/route.ts": 17,
  "src/app/api/cron/secretary/route.ts": 1,
  "src/app/api/drives/route.ts": 2,
  "src/app/api/founding/seats/route.ts": 1,
  "src/app/api/governance/rollback/route.ts": 1,
  "src/app/api/handoffs/[id]/decline/route.ts": 1,
  "src/app/api/handoffs/[id]/route.ts": 1,
  "src/app/api/handoffs/[id]/run/route.ts": 1,
  "src/app/api/instructions/activate/route.ts": 1,
  "src/app/api/instructions/discard/route.ts": 1,
  "src/app/api/instructions/proposals/[id]/route.ts": 1,
  "src/app/api/instructions/refs/import/route.ts": 1,
  "src/app/api/instructions/refs/search/route.ts": 1,
  "src/app/api/instructions/restore/route.ts": 1,
  "src/app/api/instructions/route.ts": 1,
  "src/app/api/instructions/test/route.ts": 3,
  "src/app/api/integrations/route.ts": 2,
  "src/app/api/media/[jobId]/route.ts": 1,
  "src/app/api/media/hook/[provider]/route.ts": 1,
  "src/app/api/media/upload/route.ts": 1,
  "src/app/api/models/route.ts": 1,
  "src/app/api/notifications/prefs/route.ts": 1,
  "src/app/api/oauth/register/route.ts": 1,
  "src/app/api/oauth/token/route.ts": 1,
  "src/app/api/onboard/route.ts": 1,
  "src/app/api/partner/code/route.ts": 1,
  "src/app/api/partner/route.ts": 1,
  "src/app/api/performance/route.ts": 1,
  "src/app/api/profile/route.ts": 2,
  "src/app/api/secretary/[id]/route.ts": 1,
  "src/app/api/secretary/away/proposals/[id]/route.ts": 1,
  "src/app/api/secretary/away/route.ts": 3,
  "src/app/api/secretary/booking/[token]/route.ts": 2,
  "src/app/api/secretary/booking/route.ts": 3,
  "src/app/api/secretary/calendar/route.ts": 2,
  "src/app/api/secretary/feed/[token]/route.ts": 2,
  "src/app/api/secretary/feed/route.ts": 3,
  "src/app/api/secretary/meeting/[id]/approve/route.ts": 1,
  "src/app/api/secretary/meeting/[id]/propose/route.ts": 1,
  "src/app/api/secretary/meeting/[id]/route.ts": 2,
  "src/app/api/secretary/route.ts": 1,
  "src/app/api/secretary/series/[seriesId]/export/route.ts": 1,
  "src/app/api/secretary/series/[seriesId]/keep/route.ts": 1,
  "src/app/api/secretary/walk/route.ts": 2,
  "src/app/api/support/route.ts": 1,
  "src/app/api/team/accept/route.ts": 2,
  "src/app/api/team/invite/route.ts": 3,
  "src/app/api/tools/[tool]/route.ts": 3,
  "src/app/api/waitlist/route.ts": 1,
  "src/app/api/wishlist/suggest/route.ts": 1,
  "src/app/m/[name]/route.ts": 2,
  "src/app/p/[code]/route.ts": 1,
  "src/components/admin/LeadsPanel.tsx": 1,
  "src/components/app/AwayPanel.tsx": 2,
  "src/components/app/BookingCard.tsx": 1,
  "src/components/app/LibraryPanel.tsx": 4,
  "src/components/app/MeetingPanel.tsx": 1,
  "src/components/app/TeamPanel.tsx": 5,
  "src/components/app/TopupCard.tsx": 1,
  "src/emails/layout.ts": 1,
  "src/lib/account.ts": 4,
  "src/lib/activity.ts": 2,
  "src/lib/ad-stats.ts": 1,
  "src/lib/admin-2fa.ts": 8,
  "src/lib/admin-stats.ts": 4,
  "src/lib/agent-scope.ts": 1,
  "src/lib/auth.ts": 4,
  "src/lib/billing.ts": 12,
  "src/lib/booking-token.ts": 4,
  "src/lib/brand-proposals.ts": 5,
  "src/lib/brand-rules.ts": 2,
  "src/lib/catalog.ts": 2,
  "src/lib/chat-allowance.ts": 3,
  "src/lib/chat-gates.ts": 2,
  "src/lib/chat-history.ts": 2,
  "src/lib/chat-run-tool.ts": 15,
  "src/lib/connectors/ads-via-composio.ts": 3,
  "src/lib/connectors/composio.ts": 2,
  "src/lib/connectors/fresh.ts": 1,
  "src/lib/connectors/via-composio.ts": 1,
  "src/lib/credits.ts": 9,
  "src/lib/cron-batch.ts": 2,
  "src/lib/cron-heartbeat.ts": 1,
  "src/lib/devices.ts": 2,
  "src/lib/email-change.ts": 2,
  "src/lib/fair-use.ts": 3,
  "src/lib/feed-token.ts": 3,
  "src/lib/generate-batch.ts": 4,
  "src/lib/golden.ts": 3,
  "src/lib/google-signin.ts": 1,
  "src/lib/handoff-auto.ts": 2,
  "src/lib/handoffs.ts": 9,
  "src/lib/instruction-proposals.ts": 6,
  "src/lib/instructions-store.ts": 4,
  "src/lib/judge.ts": 2,
  "src/lib/lifecycle.ts": 1,
  "src/lib/margin.ts": 4,
  "src/lib/media/higgsfield.ts": 1,
  "src/lib/media/jobs.ts": 3,
  "src/lib/media/keys.ts": 9,
  "src/lib/media/kie.ts": 2,
  "src/lib/media/store.ts": 2,
  "src/lib/mfa.ts": 6,
  "src/lib/model.ts": 3,
  "src/lib/models/credits.ts": 4,
  "src/lib/models/route.ts": 2,
  "src/lib/notifications.ts": 6,
  "src/lib/notify-prefs.ts": 1,
  "src/lib/notify.ts": 4,
  "src/lib/oauth.ts": 11,
  "src/lib/partners.ts": 15,
  "src/lib/prompt-stamp.ts": 1,
  "src/lib/provider-fault-note.ts": 1,
  "src/lib/publish-once.ts": 2,
  "src/lib/rate.ts": 14,
  "src/lib/referral.ts": 5,
  "src/lib/routines.ts": 9,
  "src/lib/safe-fetch.ts": 1,
  "src/lib/schedule.ts": 3,
  "src/lib/secretary-booking.ts": 1,
  "src/lib/secretary-cal-routes.ts": 1,
  "src/lib/secretary-calendly.ts": 1,
  "src/lib/secretary-gcal.ts": 1,
  "src/lib/secretary-handoff.ts": 2,
  "src/lib/secretary-keys.ts": 33,
  "src/lib/secretary-meeting.ts": 6,
  "src/lib/secretary-read.ts": 3,
  "src/lib/secretary-remind.ts": 1,
  "src/lib/secretary-series.ts": 1,
  "src/lib/secretary-store.ts": 1,
  "src/lib/secretary-tools.ts": 1,
  "src/lib/secretary-walk.ts": 7,
  "src/lib/social-read/common.ts": 1,
  "src/lib/spend-proposals.ts": 4,
  "src/lib/staff-code.ts": 3,
  "src/lib/staff-session.ts": 2,
  "src/lib/staff-signin.ts": 1,
  "src/lib/staff.ts": 6,
  "src/lib/store-sales.ts": 2,
  "src/lib/task-costs.ts": 2,
  "src/lib/totp.ts": 1,
  "src/lib/track.ts": 5,
  "src/lib/usage.ts": 13,
  "src/lib/verify-email.ts": 7,
  "src/lib/wishlist.ts": 2,
  "src/lib/x-stats.ts": 1,
};

const SCOPE_PARAM: Record<string, number> = {
  "src/lib/brand.ts": 26,
  "src/lib/connectors/store.ts": 7,
  "src/lib/conversations.ts": 12,
  "src/lib/decisions.ts": 1,
  "src/lib/evals.ts": 2,
  "src/lib/feedback.ts": 1,
  "src/lib/files.ts": 1,
  "src/lib/governance.ts": 5,
  "src/lib/handoffs.ts": 1,
  "src/lib/onboard-confirm.ts": 2,
  "src/lib/perf-store.ts": 3,
  "src/lib/product-stats.ts": 1, // KEY: the PostHog totals of a lib helper's string scope, as site-stats.ts does (rule 4232)
  "src/lib/push.ts": 1, // pushForActivity: the activity log's string scope, as recordActivity passes it (rule 2566)
  "src/lib/routines.ts": 1,
  "src/lib/schedule.ts": 5,
  "src/lib/site-stats.ts": 1,
  "src/lib/social-read/common.ts": 1,
  "src/lib/social-stats.ts": 1,
  "src/lib/store-sales.ts": 2,
};

const STORED_SCOPE: Record<string, number> = {
  "src/lib/auth.ts": 1,
};

// Multi-workspace membership, release M1 (rule 2137): the two constructors of the branded ids, called only where a person
// or an account id is read back from a record; each call site is listed here, none under src/app.
const STORED_PERSON_ID: Record<string, number> = {
  "src/lib/membership.ts": 1, // ownerOf: the account record's ownerPid, else acct(u)
  "src/lib/auth.ts": 8, // getLogin: the sign-in address as a legacy person id, and the person id the login index names; sessionPerson: the session's pid (index-checked); resolveIds: the session's pid (index-checked); resolveInHandle (M2): the session's pid, to read its orgs: hint (the match is re-checked by resolveIds); resolveLegacy: the legacy member's pid, and (M3, rule 2131 pre-R1 half) the session's pid or address, only to read that person's suspension; createUser: the new account's id (or a new p_ id) as its owner's person id
  "src/lib/mcp.ts": 1, // userFromBearer: the token record's address as the legacy owner's person id (used only when ownerOf agrees)
  "src/lib/verify-email.ts": 2, // moveOwnerLogin: the moved account's id as its legacy owner's person id (compared with ownerOf, and its person lock), and the new address as the new legacy owner's person id (its person lock and row)
  "src/lib/account.ts": 1, // wipeAccount: the wiped account's id as its legacy owner's person id (the person row createUser wrote), used only when the record is gone (else ownerOf)
  "src/lib/team.ts": 1, // pidFrom (multi-workspace M1): a roster entry, a legacy member's address, an invite's inviter or invited address, an address being moved, all read from records
  "src/lib/feed-token.ts": 1, // linkIds (multi-workspace M1): a feed or booking link record's pid, written by createFeed/createBook from the session's actor
  "src/lib/email-hold.ts": 2, // addressBlocked: the hold record's pid (only to ask whether that person still exists); takeRevert: the revert record's pid (its emailreverted: stamp), both written by holdOldAddress from a locked move's pid (account-id R2, rules 2743-2744)
  "src/lib/email-move.ts": 1, // revertEmailMove: the revert record's pid, written by holdOldAddress; the move re-checks it against getLogin(old).pid under the locks (rule 2744)
  "src/lib/conversions/multi-org-index.ts": 2, // S1 (rule 4100: moved from scripts/, which the scan does not read): the account record's ownerPid (else its id) and each roster entry, all read from records
  "src/lib/passkeys.ts": 1, // resolvePasskeyLogin (customer passkeys, pre-flight ruling 3): the pid a `pkcred:` reverse entry names, written by addPasskey/movePasskeys, forward-checked (getPerson, getLogin(person.email).pid, the credential in that pid's set)
};
const STORED_ACCOUNT_ID: Record<string, number> = {
  "src/lib/conversions/multi-org-index.ts": 1, // S1 (rule 4100: moved from scripts/): each id in users:all, the account's own record key
  "src/lib/membership.ts": 6, // aidOf: a resolved account's own id; listOrgs: an orgs:{pid} entry (re-checked); legacyHomeOf/legacyHomeFrom: a legacy owner's own id (twice), a legacy memberOf; pickAccount: lastorg:{pid} (re-checked)
  "src/lib/auth.ts": 4, // getLogin: a legacy owner's own id, a legacy member's memberOf; resolveIds: the session's acct (re-checked against the account record and roleIn); resolveLegacy (customer roles, rule 3752): the legacy member's own memberOf, to read its membership row in the same round
  "src/lib/mcp.ts": 1, // userFromBearer: the token record's address as the legacy account id (used only when aidOf agrees)
  "src/lib/person.ts": 2, // updatePerson: a legacy owner's person id as its own account id (mirror, stampOwned; re-checked with ownerOf)
  "src/lib/team.ts": 1, // aidFrom (multi-workspace M1): an account id from a resolved user or a record (an invite's account, a legacy memberOf, an orgs:{pid} entry)
  "src/lib/feed-token.ts": 1, // linkIds (multi-workspace M1): a feed or booking link record's aid, written by createFeed/createBook from the session's account (re-checked by loginHolds)
  "src/lib/account.ts": 1, // wipeAccount (multi-workspace M1): the wiped account's id as its callers hold it (acct(u) of a resolved account, or the console's lookup by address)
};
