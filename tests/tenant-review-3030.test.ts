import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newOpaqueUser, newUser, readActiveBrand, seedActiveBrand, signIn, signOut, withHeaders } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, getUser, saveUser, sc, type User } from "@/lib/auth";
import { saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import { accountKey } from "@/lib/keys";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { BRAND_HEADER } from "@/lib/brand-path";
import { markSent, onceKey } from "@/lib/notify";
import { runLifecycle } from "@/lib/lifecycle";
import { SEC_KEYS, newSecId, newSeriesId } from "@/lib/secretary";
import { sweepReminders } from "@/lib/secretary-remind";
import { warnSeries } from "@/lib/secretary-series";
import { followUps, type Notif } from "@/lib/notifications";
import { saveConnection } from "@/lib/connectors/store";
import { readPrefs } from "@/lib/notify-prefs";
import type { SecItem } from "@/lib/secretary-agenda";
import * as brandsRoute from "@/app/api/brands/route";
import NotificationsPage from "@/app/[lang]/app/b/[brand]/settings/notifications/page";

/**
 * Tenant review fixes, rules 3030-3033 (docs/system/tests/3030-tenant-review.md):
 * - 3030: an MCP token acts only on an ACTIVE brand of its account; archiving a brand resets the acting person's stored
 *   choice whenever it names that brand, even from another brand's page.
 * - 3031: Reem's reminder and series-warning emails go to the owner's address from the loaded record, never to the
 *   account id taken from the scope.
 * - 3032: the notification preferences' fallback record and the brand tag are the account's (`acct(u)`), not the address's.
 * - 3033: lifecycle one-time markers are the account's; an address-keyed marker from before counts as sent.
 */

const sends: string[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: { to: string }) => { sends.push(msg.to); return { data: { id: "re_ok" }, error: null }; } };
  },
}));
const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key"); vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>"); };

beforeEach(() => { sends.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); signOut(); });

const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
const T0 = "2026-10-01T00:00:00.000Z";
const row = (id: string, status: BrandMeta["status"] = "active", name = ""): BrandMeta => ({ id, name, createdAt: T0, status });
const brandFile = (name: string): Brand => ({ name, website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "coffee", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: T0 });
const archive = (id: string) => brandsRoute.POST(json("/api/brands", "POST", { action: "archive", id }));

describe("rule 3030: an MCP token never acts on an archived brand", () => {
  for (const legacy of [true, false]) {
    it(`${legacy ? "a legacy owner (in-round read)" : "a p_ owner (second round)"}: the chosen brand while active, the default brand once it is archived`, async () => {
      const u = await newUser(`r3030${legacy ? "l" : "p"}`, { legacy });
      await saveBrands(acct(u), [row("default"), row("bx")]);
      await seedActiveBrand(u.email, "bx");
      const t = await createMcpToken(acct(u));
      const on = (await userFromBearer(bearer(t)))!;
      expect(on.brandId).toBe("bx");
      expect(sc(on)).toBe(scopeFor(acct(u), "bx"));
      // The list as an archive from another brand's page left it before this fix: bx archived, the stored choice still bx.
      await saveBrands(acct(u), [row("default"), row("bx", "archived")]);
      expect(await readActiveBrand(u.email)).toBe("bx");
      const off = (await userFromBearer(bearer(t)))!;
      expect(off.brandId).toBe("default");
      expect(sc(off)).toBe(acct(u));
      // A brand id the account never had is the default brand too.
      await seedActiveBrand(u.email, "gone");
      expect((await userFromBearer(bearer(t)))!.brandId).toBe("default");
    });
  }

  it("an opaque account's token checks the brand list of ITS account", async () => {
    const u = await newOpaqueUser("r3030o");
    await saveBrands(acct(u), [row("default"), row("bo")]);
    await seedActiveBrand(u.email, "bo");
    const t = await createMcpToken(acct(u));
    expect((await userFromBearer(bearer(t)))!.brandId).toBe("bo");
    await saveBrands(acct(u), [row("default"), row("bo", "archived")]);
    expect((await userFromBearer(bearer(t)))!.brandId).toBe("default");
  });

  it("the brand list is read in the same round as the account; a failed read is the default brand, not a refusal", async () => {
    const u = await newUser("r3030r", { legacy: true });
    await saveBrands(acct(u), [row("default"), row("br")]);
    await seedActiveBrand(u.email, "br");
    const t = await createMcpToken(acct(u));
    await userFromBearer(bearer(t)); // moves nothing on a hashed token, warms the record
    const r = trackRounds();
    expect((await userFromBearer(bearer(t)))!.brandId).toBe("br");
    const roundOf = (key: string) => r.calls.find((c) => c.key === key)?.round;
    expect(roundOf(accountKey.brands(acct(u)))).toBeDefined();
    expect(roundOf(accountKey.brands(acct(u)))).toBe(roundOf(accountKey.user(acct(u))));
    vi.restoreAllMocks();
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation((async (key: string) => {
      if (key === accountKey.brands(acct(u))) throw new Error("store down");
      return real(key);
    }) as never);
    const u2 = (await userFromBearer(bearer(t)))!;
    expect(u2).not.toBeNull();
    expect(u2.brandId).toBe("default");
  });

  it("the owner archives X from /b/Y: the stored choice X is reset, so the token and a legacy session leave X", async () => {
    const u = await newUser("r3030a");
    await saveBrands(acct(u), [row("default"), row("bx"), row("by")]);
    await seedActiveBrand(u.email, "bx");
    const t = await createMcpToken(acct(u));
    await signIn(u.email);
    const res = await withHeaders({ [BRAND_HEADER]: "by" }, () => archive("bx"));
    expect(res.status).toBe(200);
    expect(await readActiveBrand(u.email)).toBe("default");
    expect((await userFromBearer(bearer(t)))!.brandId).toBe("default");
  });

  it("archiving another brand leaves the stored choice alone; a restore resets nothing", async () => {
    const u = await newUser("r3030k");
    await saveBrands(acct(u), [row("default"), row("bx"), row("by")]);
    await seedActiveBrand(u.email, "by");
    await signIn(u.email);
    expect((await withHeaders({ [BRAND_HEADER]: "by" }, () => archive("bx"))).status).toBe(200);
    expect(await readActiveBrand(u.email)).toBe("by");
    // The archive action on an archived brand restores it (under the brand cap, so the account gets room for it).
    await saveUser({ ...(await getUser(acct(u)))!, brandCap: 10 } as User);
    expect((await withHeaders({ [BRAND_HEADER]: "by" }, () => archive("bx"))).status).toBe(200);
    expect(await readActiveBrand(u.email)).toBe("by");
  });

  it("an admin archives X from /b/Y: the admin's own stored X and the owner's stored X are both reset", async () => {
    const owner = await newUser("r3030ow");
    await saveBrands(acct(owner), [row("default"), row("bx"), row("by")]);
    const admin = await newMember(owner, "admin", "r3030ad");
    await Promise.all([seedActiveBrand(owner.email, "bx"), seedActiveBrand(admin.email, "bx")]);
    await signIn(admin.email);
    expect((await withHeaders({ [BRAND_HEADER]: "by" }, () => archive("bx"))).status).toBe(200);
    expect(await readActiveBrand(admin.email)).toBe("default");
    expect(await readActiveBrand(owner.email)).toBe("default");
  });
});

/** One open to-do with a reminder already due, indexed the way `indexWrites` leaves it. */
async function dueReminder(scope: string, title: string): Promise<SecItem> {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const it: SecItem = {
    id: newSecId(), kind: "task", title, description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false,
    links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, remindAt: at, rev: 1,
  } as SecItem;
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), 32503680000000, it.id), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.due(scope), Date.parse(at), it.id), db.zadd(SEC_KEYS.dueScopes, Date.parse(at), scope)]);
  return it;
}
/** One closed copy of a series, closed `closedAt`, in sdone (the series warning's candidates). */
async function closedCopy(scope: string, sid: string, closedAt: number): Promise<void> {
  const iso = new Date(closedAt).toISOString();
  const it = {
    id: newSecId(), kind: "task", title: "Water the plants", description: "", result: "ok", direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: iso, allDay: false, snoozeUntil: null, priority: 1,
    critical: false, links: {}, source: "owner", notes: [], createdAt: iso, updatedAt: iso, completedAt: iso, proposedDone: null, deletedAt: null, expiresAt: null, expectBy: null, lastChasedAt: null,
    remindAt: null, rev: 2, series: { id: sid, n: 1 },
  } as SecItem;
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.series(scope, sid), closedAt, it.id), db.sadd(SEC_KEYS.seriesList(scope), sid), db.zadd(SEC_KEYS.sdone(scope), closedAt, it.id)]);
}

describe("rule 3031: Reem's emails go to the owner's address, never to the account id", () => {
  it("a due reminder of an opaque account is mailed to its address", async () => {
    mailOn();
    const u = await newOpaqueUser("r3031r");
    expect(acct(u)).not.toBe(u.email);
    await dueReminder(acct(u), "Call the bank");
    await sweepReminders(Date.now());
    expect(sends).toContain(u.email);
    expect(sends).not.toContain(acct(u));
  });

  it("the series warning of an opaque account is mailed to its address; a scope with no account record mails nobody", async () => {
    mailOn();
    const DAY = 864e5;
    const T = Date.parse("2026-10-05T06:00:00Z");
    const u = await newOpaqueUser("r3031s");
    await closedCopy(acct(u), newSeriesId(), T - 100 * DAY);
    expect(await warnSeries(acct(u), T)).toBe(1);
    expect(sends).toEqual([u.email]);
    sends.length = 0;
    const ghost = `a_${"0".repeat(20)}ghost`;
    await closedCopy(ghost, newSeriesId(), T - 100 * DAY);
    await warnSeries(ghost, T);
    expect(sends).toEqual([]);
  });

  it("the sources hold no send to the account id", () => {
    expect(readFileSync("src/lib/secretary-remind.ts", "utf8")).toMatch(/to: ctx\.user\.email,/);
    expect(readFileSync("src/lib/secretary-remind.ts", "utf8")).not.toMatch(/to: ctx\.email/);
    expect(readFileSync("src/lib/secretary-series.ts", "utf8")).toMatch(/if \(user && emailAllowed\(await readPrefs\(scope, email\), "reminders"\)\) await sendEmail\(\{ to: user\.email,/);
  });
});

describe("rule 3032: preferences fall back to the ACCOUNT's record and the brand tag reads the account's brands", () => {
  it("Settings > Notifications on an added brand of an opaque account shows the account's choices", async () => {
    const u = await newOpaqueUser("r3032p");
    await saveBrands(acct(u), [row("default"), row("b1")]);
    await db.set(`profile:${acct(u)}`, { emails: "none" });
    await db.set(`profile:${u.email}`, { emails: "all" });
    await signIn(u.email);
    const el = (await withHeaders({ [BRAND_HEADER]: "b1" }, () => NotificationsPage({ params: Promise.resolve({ lang: "en" }) }))) as { props: { children: { props: { initial?: unknown } }[] } };
    const initial = el.props.children.map((c) => c?.props?.initial).find(Boolean) as { brief: string };
    expect(initial.brief).toBe("none");
    // The senders read the same record (readPrefsMany's account fallback is profile:{account}).
    expect((await readPrefs(scopeFor(acct(u), "b1"), acct(u))).brief).toBe("none");
  });

  it("a reconnect notice of an opaque account's second brand names the brand", async () => {
    const u = await newOpaqueUser("r3032t");
    await saveBrands(acct(u), [row("default"), row("b1", "active", "Roastery")]);
    const scope = scopeFor(acct(u), "b1");
    await saveConnection(scope, { provider: "salla", data: { access_token: "test-token" }, meta: { account: "Shop" }, connectedAt: T0, needsReconnect: "2026-10-18T02:00:00Z" });
    const user = { ...(await getUser(acct(u)))!, lang: "en" as const } as User;
    const out = (await followUps(user, scope)).filter((n: Notif) => n.href.endsWith("/settings/connections"));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Reconnect Salla (سلة) — Roastery");
  });

  it("the evening wrap, the settings page and the reconnect notice name acct, never the address", () => {
    const evening = readFileSync("src/lib/secretary-evening.ts", "utf8");
    expect(evening).toMatch(/readPrefs\(scope, acct\(user\)\)/);
    expect(evening).not.toMatch(/readPrefs\(scope, user\.email\)/);
    expect(readFileSync("src/app/[lang]/app/b/[brand]/settings/notifications/page.tsx", "utf8")).toMatch(/readPrefs\(sc\(u\), acct\(u\)\)/);
    const notifications = readFileSync("src/lib/notifications.ts", "utf8");
    expect(notifications).not.toMatch(/brandTag\(user\.email/);
    expect(notifications).toMatch(/brandTag\(acct\(user\), scope\)\)/);
  });
});

describe("rule 3033: lifecycle notes are marked per ACCOUNT and still go to the address", () => {
  /** An opaque owner on its second day, with a brand file, as the daily cron hands it over (`scope` set). */
  async function dayOne(prefix: string, email?: string): Promise<User> {
    const u = await newOpaqueUser(prefix);
    await saveBrand(acct(u), brandFile("Roastery"));
    return { ...u, ...(email ? { email } : {}), scope: acct(u), createdAt: new Date(Date.now() - 1.5 * 864e5).toISOString(), trialEnds: new Date(Date.now() + 5 * 864e5).toISOString() } as User;
  }

  it("the marker is the account's, the note goes to the address, once", async () => {
    mailOn();
    const u = await dayOne("r3033a");
    expect(await runLifecycle(u)).toEqual(["day1"]);
    expect(sends).toEqual([u.email]);
    expect(await db.get(onceKey(acct(u), "lifecycle:day1"))).toMatchObject({ sent: expect.any(String) });
    expect(await db.get(onceKey(u.email, "lifecycle:day1"))).toBeFalsy();
    expect(await runLifecycle(u)).toEqual([]);
    expect(sends).toHaveLength(1);
  });

  it("two workspaces owned at one address each get their note", async () => {
    mailOn();
    const a = await dayOne("r3033b");
    const b = await dayOne("r3033c", a.email);
    expect(await runLifecycle(a)).toEqual(["day1"]);
    expect(await runLifecycle(b)).toEqual(["day1"]);
    expect(sends).toEqual([a.email, a.email]);
  });

  it("expand: a note marked sent under the address before this release is not sent again", async () => {
    mailOn();
    const u = await dayOne("r3033d");
    await markSent(u.email, "lifecycle:day1");
    expect(await runLifecycle(u)).toEqual([]);
    expect(sends).toEqual([]);
    expect(await db.get(onceKey(acct(u), "lifecycle:day1"))).toBeFalsy();
  });

  it("a legacy account (id = address) keeps its one key and makes no extra read", async () => {
    mailOn();
    const u0 = await newUser("r3033e", { legacy: true });
    await saveBrand(acct(u0), brandFile("Roastery"));
    const u = { ...u0, scope: acct(u0), createdAt: new Date(Date.now() - 1.5 * 864e5).toISOString(), trialEnds: new Date(Date.now() + 5 * 864e5).toISOString() } as User;
    expect(acct(u)).toBe(u.email);
    const r = trackRounds();
    expect(await runLifecycle(u)).toEqual(["day1"]);
    expect(r.calls.filter((c) => c.op === "get" && c.key === onceKey(u.email, "lifecycle:day1"))).toHaveLength(2); // sendOnce's own read and re-read
    expect(sends).toEqual([u.email]);
  });
});
