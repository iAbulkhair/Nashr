import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember, newUser, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { acct } from "@/lib/account-id";
import { accountKey, globalKey } from "@/lib/keys";
import { aboutKey, collapse, listNotifs, markAllRead, pushNotif, type Notif } from "@/lib/notifications";
import { digestEntries, digestFor, digestMail, getDigest, saveDigest, sweepDigests, windowEnded } from "@/lib/notif-digest";
import { Times } from "@/components/app/NotificationCenter";
import NotifyPrefsSettings from "@/components/app/settings/NotifyPrefsSettings";
import { prefsFromLevel } from "@/lib/notify-prefs";
import * as digestRoute from "@/app/api/notifications/digest/route";

const sent: { to: string; subject: string; text: string }[] = [];
let refuse = false;
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    if (refuse) return false;
    sent.push({ to: m.to, subject: m.subject, text: m.text });
    return true;
  },
}));

/**
 * Rules 2350-2357: one bell entry per subject with a counter, and the digest email the owner chooses (study 2026-10-19
 * pattern 2, after Fizzy's notifications and bundles). docs/system/tests/2350-notif-collapse-digest.md lists what each
 * test pins.
 */
const H = 36e5;
const read = (p: string) => readFileSync(p, "utf8");
const entry = (id: string, over: Partial<Notif> = {}): Notif => ({ id, kind: "pending", title: `t ${id}`, body: "b", href: "/ar/app", at: new Date().toISOString(), ...over });
let n = 0;
const acc = () => `digest${++n}@test.example`;

beforeEach(() => { sent.length = 0; refuse = false; });

describe("rules 2350-2351: one entry per subject, with a counter", () => {
  it("a fresh entry replaces the older one about the same subject and counts it while it was unread", () => {
    const old = entry("a", { about: "pending:s" });
    expect(collapse([entry("b", { about: "pending:s" })], [old, entry("c")]).map((x) => [x.id, x.count])).toEqual([["b", 2], ["c", undefined]]);
    expect(collapse([entry("d", { about: "pending:s" })], [{ ...old, count: 4 }])[0].count).toBe(5);
    // Read: the counter starts again.
    expect(collapse([entry("e", { about: "pending:s" })], [{ ...old, read: true, count: 4 }]).map((x) => [x.id, x.count])).toEqual([["e", undefined]]);
    // No subject, or another subject: nothing collapses.
    expect(collapse([entry("f")], [entry("g")]).map((x) => x.id)).toEqual(["f", "g"]);
    expect(collapse([entry("h", { about: "due:s" })], [old]).map((x) => x.id)).toEqual(["h", "a"]);
    // Two about one subject in the same push: one entry, counted twice.
    expect(collapse([entry("j", { about: "x" }), entry("i", { about: "x" })], []).map((x) => [x.id, x.count])).toEqual([["j", 2]]);
  });
  it("the bell keeps one entry per subject across pushes with different fingerprints", async () => {
    const a = acc();
    const about = aboutKey("pending", a);
    await pushNotif(a, { kind: "pending", title: "3 waiting", body: "", href: "/ar/app", about }, "pending:0");
    await pushNotif(a, { kind: "pending", title: "6 waiting", body: "", href: "/ar/app", about }, "pending:1");
    await pushNotif(a, { kind: "due", title: "due", body: "", href: "/ar/app", about: aboutKey("due", a) }, "due:x");
    const bell = await listNotifs(a);
    expect(bell.map((x) => [x.title, x.count])).toEqual([["due", undefined], ["6 waiting", 2]]);
    await markAllRead(a);
    await pushNotif(a, { kind: "pending", title: "9 waiting", body: "", href: "/ar/app", about }, "pending:2");
    expect((await listNotifs(a)).filter((x) => x.about === about).map((x) => [x.title, x.count, !!x.read])).toEqual([["9 waiting", undefined, false]]);
  });
  it("the follow-ups, the Not now notices and Reem's to-do notices name their subject", () => {
    const src = read("src/lib/notifications.ts");
    for (const what of ["due", "pending", "notnow", "quality", "reconnect"]) expect(src).toContain(`aboutKey("${what}", scope)`);
    expect(src).toContain('aboutKey("todo", scope, it.id)');
    expect(read("src/lib/secretary-remind.ts")).toContain('aboutKey("todo", scope, item.id)');
    expect(read("src/lib/schedule.ts")).toContain('aboutKey("notnow", scope)');
    expect(aboutKey("todo", "a@b.c#br1", "i1")).toBe("todo:a@b.c#br1:i1");
  });
});

describe("rule 2352: the bell shows the counter", () => {
  it("×N next to the title with the number in words for screen readers, nothing for one", () => {
    expect(renderToStaticMarkup(h(Times, { count: 3, label: "{n} notices about this" }))).toContain("×3");
    expect(renderToStaticMarkup(h(Times, { count: 3, label: "{n} notices about this" }))).toContain('class="sr-only">3 notices about this');
    expect(renderToStaticMarkup(h(Times, { count: 150, label: "{n}" }))).toContain("×99+");
    expect(renderToStaticMarkup(h(Times, { count: 1, label: "{n}" }))).toBe("");
    expect(renderToStaticMarkup(h(Times, { label: "{n}" }))).toBe("");
    expect(read("src/components/app/NotificationCenter.tsx")).toContain("<Times count={n.count} label={U.times} />");
    expect(read("src/components/app/NotificationsPanel.tsx")).toContain("<Times count={n.count} label={U.times} />");
  });
});

describe("rule 2353: the digest choice", () => {
  it("is off until chosen; on writes the record, the window and the tick's set; off removes all three", async () => {
    const a = acc();
    expect(await getDigest(a)).toBe("off");
    await saveDigest(a, "day", a, "ar");
    expect(await getDigest(a)).toBe("day");
    expect(await db.get(accountKey.digestLast(a))).toEqual(expect.any(String));
    expect(await db.smembers(globalKey.digests())).toContain(a);
    await saveDigest(a, "off", a, "ar");
    expect(await getDigest(a)).toBe("off");
    expect(await db.get(accountKey.digest(a))).toBeNull();
    expect(await db.get(accountKey.digestLast(a))).toBeNull();
    expect(await db.smembers(globalKey.digests())).not.toContain(a);
  });
  it("the settings page shows four choices, off by default, and saves through its own route", () => {
    const html = renderToStaticMarkup(h(NotifyPrefsSettings, { lang: "en", initial: prefsFromLevel("all"), canEdit: true }));
    for (const v of ["4h", "day", "week"]) expect(html).toContain(`name="digest" value="${v}"`);
    expect(html).toContain('name="digest" checked="" value="off"');
    expect(read("src/components/app/settings/NotifyPrefsSettings.tsx")).toContain('"/api/notifications/digest"');
    expect(read("src/app/[lang]/app/b/[brand]/settings/notifications/page.tsx")).toContain("getDigest(acct(u))");
  });
});

describe("rule 2354: the tick sends one email per window, only with what is new and unread", () => {
  it("starts a window, waits, then sends the unread entries of that window once", async () => {
    const a = acct(await newUser("dg")); // a real account: the tick reads it again (rule 2507)
    await saveDigest(a, "4h", a, "en");
    const start = Date.parse((await db.get<string>(accountKey.digestLast(a)))!);
    expect(await digestFor(a, start + H)).toBe("wait");
    await db.set(accountKey.notifications(a), [
      entry("new", { title: "Fresh", at: new Date(start + H).toISOString(), count: 3 }),
      entry("seen", { title: "Seen", at: new Date(start + H).toISOString(), read: true }),
      entry("old", { title: "Old", at: new Date(start - H).toISOString() }),
    ]);
    expect(await digestFor(a, start + 4 * H)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(a);
    expect(sent[0].text).toContain("Fresh (×3)");
    expect(sent[0].text).not.toContain("Seen");
    expect(sent[0].text).not.toContain("Old");
    // The window closed: the next tick waits, and the one after the next window finds nothing new.
    expect(await digestFor(a, start + 4 * H + 15 * 6e4)).toBe("wait");
    await db.del(accountKey.digestLock(a));
    expect(await digestFor(a, start + 8 * H + 6e4)).toBe("empty");
    expect(sent).toHaveLength(1);
  });
  it("a refused send keeps the window open for a later tick; a claimed send is not made twice", async () => {
    const a = acct(await newUser("dg")); // a real account: the tick reads it again (rule 2507)
    await saveDigest(a, "day", a, "ar");
    const start = Date.parse((await db.get<string>(accountKey.digestLast(a)))!);
    await db.set(accountKey.notifications(a), [entry("x", { at: new Date(start + H).toISOString() })]);
    refuse = true;
    expect(await digestFor(a, start + 24 * H)).toBe("failed");
    expect(await digestFor(a, start + 24 * H)).toBe("busy");
    refuse = false;
    await db.del(accountKey.digestLock(a));
    expect(await digestFor(a, start + 24 * H + 15 * 6e4)).toBe("sent");
    expect(sent).toHaveLength(1);
  });
  it("an account without a record leaves the set; one without a window starts one; the sweep tallies", async () => {
    const a = acc();
    await db.sadd(globalKey.digests(), a);
    expect(await digestFor(a, Date.now())).toBe("off");
    expect(await db.smembers(globalKey.digests())).not.toContain(a);
    const b = acct(await newUser("dg"));
    await saveDigest(b, "week", b, "en");
    await db.del(accountKey.digestLast(b));
    expect(await digestFor(b, Date.now())).toBe("start");
    const tally = await sweepDigests(Date.now(), Date.now() + 60e3);
    expect(tally.wait).toBeGreaterThanOrEqual(1);
    expect(read("src/app/api/cron/secretary/route.ts")).toContain("sweepDigests(now, deadline)");
  });
  it("windows, entries and the email's text", () => {
    expect(windowEnded("4h", new Date(0).toISOString(), 4 * H - 11 * 6e4)).toBe(false);
    expect(windowEnded("4h", new Date(0).toISOString(), 4 * H - 9 * 6e4)).toBe(true);
    expect(windowEnded("week", new Date(0).toISOString(), 167 * H)).toBe(false);
    const since = new Date(1000).toISOString();
    expect(digestEntries([entry("a", { at: new Date(2000).toISOString() }), entry("b", { at: new Date(500).toISOString() }), entry("c", { at: new Date(9000).toISOString() })], since, 5000).map((x) => x.id)).toEqual(["a"]);
    const many = Array.from({ length: 25 }, (_, i) => entry(String(i)));
    const m = digestMail("ar", "day", many);
    expect(m.subject).toBe("25 تنبيه من فريق ذكين");
    expect(m.text).toContain("و5 غيرها في صفحة التنبيهات.");
    expect(m.href).toMatch(/\/ar\/app\/notifications$/);
  });
});

describe("rule 2355: PUT /api/notifications/digest", () => {
  it("signs in, is the owner's, refuses a bad choice, and writes the session's own account with its own address", async () => {
    const put = (b: unknown) => digestRoute.PUT(json("/api/notifications/digest", "PUT", b));
    expect((await put({ every: "day" })).status).toBe(401);
    const owner = await newUser("ndo");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await put({ every: "day" })).status).toBe(403);
    await signIn(owner.email);
    expect((await put({ every: "hourly" })).status).toBe(400);
    const res = await put({ every: "4h", to: "victim@test.example", account: "victim@test.example" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, every: "4h" });
    expect(await db.get(accountKey.digest(owner.email))).toEqual(expect.objectContaining({ v: 1, every: "4h", to: owner.email }));
    expect(await db.get(accountKey.digest("victim@test.example"))).toBeNull();
  });
});

describe("rules 2356-2357: no second email, and nothing left behind", () => {
  it("with a digest on, the daily job no longer emails the follow-ups itself", () => {
    const src = read("src/app/api/cron/daily/route.ts");
    expect(src).toContain('const mailed = digest === "off" ? fu : [];');
    expect(src).toContain("notifEmailText(u, mailed)");
    expect(src).toContain('} else if (mailed.length && prefs.brief !== "none") {');
  });
  it("the account wipe deletes the digest records and takes the account out of the tick's set", () => {
    const src = read("src/lib/account.ts");
    for (const k of ["accountKey.digest(e)", "accountKey.digestLast(e)", "accountKey.digestLock(e)", "db.srem(globalKey.digests(), e)"]) expect(src).toContain(k);
  });
});
