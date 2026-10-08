// Rules 753, 755, 756 in docs/system/tests.md: tokens, public links and scheduled jobs wait for a verified owner.
// An unverified owner reads as signed out (rule 751), so every door that does not go through `currentUser` has to
// refuse the same account: the MCP bearer, the feed and booking links, the daily roster and the reminder sweep.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newMember, newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser, saveUser, type User } from "@/lib/auth";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { dailyRoster } from "@/lib/schedule";
import { SEC_KEYS } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";
import { loginHolds } from "@/lib/secretary-feed";
import { getItem } from "@/lib/secretary";
import { SUSPENDED_HOLD_MS, sweepReminders } from "@/lib/secretary-remind";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (to: string, subject: string, text: string) => { sent.push({ to, subject, text }); return true; } }));

beforeEach(() => { sent.length = 0; });

const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
/** Stamp the address as proved, the way the verify route does. */
const verify = async (email: string) => { const u = (await getUser(email))!; await saveUser({ ...u, emailVerifiedAt: new Date().toISOString() }); };
/** A reminder that fell due a minute ago, written the way the sweep reads it (as in tests/secretary-phase2.test.ts). */
async function seedDue(scope: string, title: string): Promise<SecItem> {
  const at = new Date().toISOString();
  const remindAt = new Date(Date.now() - 60_000).toISOString();
  const it: SecItem = { id: `s${Buffer.from(scope + title).toString("hex").slice(0, 16)}`, kind: "task", title, description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, remindAt, rev: 1 };
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), 32503680000000, it.id), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.due(scope), Date.parse(remindAt), it.id), db.zadd(SEC_KEYS.dueScopes, Date.parse(remindAt), scope)]);
  return it;
}
const later = () => new Date(Date.now() + 5_000).toISOString();

describe("email verification: tokens, links and jobs (rules 753, 755, 756)", () => {
  it("bearer refuses an unverified owner", async () => {
    const u = await newUser("b", { verified: false });
    const t = await createMcpToken(u.email);
    expect(await userFromBearer(bearer(t))).toBeNull();
    await verify(u.email);
    expect((await userFromBearer(bearer(t)))?.email).toBe(u.email);
  });

  it("dailyRoster leaves unverified owners out", async () => {
    const ok = await newUser("rosterok");
    const un = await newUser("rosterun", { verified: false });
    const { users, idle } = await dailyRoster();
    const emails = users.map((x: User) => x.email);
    expect(emails).toContain(ok.email);
    expect(emails).not.toContain(un.email);
    expect(idle).toContain(un.email);
    expect(idle).not.toContain(ok.email);
  });

  it("reminders wait for an unverified owner", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const un = await newUser("remun", { verified: false });
    const it = await seedDue(un.email, "Wait for me");
    await sweepReminders(Date.now());
    expect(sent.filter((m) => m.to === un.email)).toEqual([]);
    expect((await getItem(un.email, it.id))?.remindAt).toBe(it.remindAt);
    // Once verified, the next sweep (past the hold) delivers it.
    await verify(un.email);
    await sweepReminders(Date.now() + SUSPENDED_HOLD_MS + 1000);
    expect((await getItem(un.email, it.id))?.remindAt).toBeNull();
  });

  it("feed and booking links refuse while the owner is unverified", async () => {
    const un = await newUser("lnk", { verified: false });
    const rec = { login: un.email, scope: un.email, createdAt: later() };
    expect(await loginHolds(rec)).toBe(false);
    await verify(un.email);
    expect(await loginHolds(rec)).toBe(true);

    // A member's link is refused while the owner behind it is unverified.
    const owner = await newUser("lnkown");
    const m = await newMember(owner);
    const mrec = { login: m.email, scope: owner.email, createdAt: later() };
    expect(await loginHolds(mrec)).toBe(true);
    await saveUser({ ...(await getUser(owner.email))!, emailVerifiedAt: undefined });
    expect(await loginHolds(mrec)).toBe(false);
  });
});
