import { describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server.edge";
import { jar, json, newMember, newUser, params, settle, signIn, signOut, supportAccess } from "./helpers/session";
import { currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { addBrand, scopeFor } from "@/lib/brands";
import { saveTask, type Task } from "@/lib/brand";
import { CAPS, db } from "@/lib/db";
import { listDecisions } from "@/lib/decisions";
import { byOf, systemBy } from "@/lib/actor";
import { AGENT_CAP_MAX, DEFAULT_GOV, getGov, govDiff, listGovHistory, rollbackGov, saveGovAs, type Governance, type GovRevision } from "@/lib/governance";
import { GOV_ROLLBACKS_PER_HOUR } from "@/lib/rate";
import { wipeAccount } from "@/lib/account";
import * as govRoute from "@/app/api/governance/route";
import * as rollbackRoute from "@/app/api/governance/rollback/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as adminUser from "@/app/api/admin/users/[email]/route";
import Page from "@/app/[lang]/app/governance/page";
import { appDict } from "@/lib/app-i18n";

/**
 * Rules 193-196 and 199: who acted is worked out in code (193); a governance save that changes something is kept as a
 * revision, under a lock, and a save that changes nothing is not (194); a restore puts a whole snapshot back through
 * today's checks and is itself a revision, looked up only in the caller's own history (195); the Governance page shows
 * the history from the server, with support access as support and never who impersonated (196); and the history goes
 * with the account (199).
 */
const put = async (body: unknown) => {
  const res = await govRoute.PUT(json("/api/governance", "PUT", body));
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; governance?: Governance; entry?: { id: string; by?: unknown; changes: { path: string }[] } | null } };
};
const restore = async (id: unknown) => {
  const res = await rollbackRoute.POST(json("/api/governance/rollback", "POST", { id }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; governance?: Governance; entry?: { id: string; by?: unknown; rollbackOf?: string; changes: { path: string }[] } | null } };
};
const owner = async (prefix: string) => {
  const u = await newUser(prefix);
  await signIn(u.email);
  return u;
};
const OWNER = (u: User) => ({ kind: "owner", email: u.email });

describe("who acted is worked out in code (rule 193)", () => {
  /** What a request resolves to for this login: `currentUser` sets `u.actor` from the session record. */
  const session = async (email: string, opts: { imp?: string } = {}) => {
    await signIn(email, opts);
    return (await currentUser())!;
  };

  it("from the session: the owner, and a founder's support access (a session carrying `imp`) as the founder by their own email", async () => {
    const u = await newUser("by-session");
    expect(byOf(await session(u.email))).toEqual(OWNER(u));
    // The console's impersonation session names the founder in `imp`; `actor.email` there is the owner's and is never who.
    const imp = await session(u.email, { imp: "founder@test.example" });
    expect(imp.actor).toMatchObject({ kind: "founder", email: u.email, impersonating: "founder@test.example" });
    expect(byOf(imp)).toEqual({ kind: "founder", email: u.email, imp: "founder@test.example" });
    expect(byOf(await session(u.email, { imp: "key" }))).toEqual({ kind: "founder", email: u.email, imp: "key" });
  });

  it("the impersonation cookies are not a way to be recorded as support: only the session record is read", async () => {
    const u = await newUser("by-cookie");
    const own = await session(u.email);
    try {
      // The cookies the console leaves, with the founder's own live session in nashr_return and the admin key cookie:
      // values any browser can set, so an owner's own actions stay the owner's.
      await supportAccess(u.email);
      vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-0123456789");
      jar().set("nashr_admin", "test-admin-key-0123456789");
      expect(byOf((await currentUser())!)).toEqual(OWNER(u));
      expect(byOf(own)).toEqual(OWNER(u));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a member's own login and role, a connected app, and no actor at all (a cron or a script) is the system, never the owner", async () => {
    const u = await newUser("by-actor");
    const as = (actor: unknown) => byOf({ ...u, actor } as User);
    const m = await newMember(u, "admin", "by-mem");
    expect(byOf(await session(m.email))).toEqual({ kind: "member", email: m.email, role: "admin" });
    expect(as({ kind: "member", email: "m@test.example", role: "member" })).toEqual({ kind: "member", email: "m@test.example", role: "member" });
    // A role a member can never hold is dropped, not recorded.
    expect(as({ kind: "member", email: "m@test.example", role: "owner" })).toEqual({ kind: "member", email: "m@test.example" });
    expect(as({ kind: "member", email: "m@test.example", role: "root" })).toEqual({ kind: "member", email: "m@test.example" });
    expect(as({ kind: "token", email: u.email, role: "owner" })).toEqual({ kind: "token", email: u.email });
    expect(as({ kind: "robot", email: u.email, role: "owner" })).toEqual({ kind: "system", job: "cron" });
    expect(byOf(u), "a user loaded with getUser carries no actor").toEqual({ kind: "system", job: "cron" });
    expect(systemBy("auto_handoff")).toEqual({ kind: "system", job: "auto_handoff" });
  });

  it("a decision made through support access is recorded as the founder's, and a `by` in the body is ignored", async () => {
    const u = await owner("by-dec");
    const t = (id: string): Task => ({ id, type: "social", channel: "instagram", title: id, body: "قهوة اليوم من محمصتنا في الرياض", status: "pending", createdAt: new Date().toISOString(), lang: "ar" });
    await Promise.all([saveTask(u.email, t("own"), true), saveTask(u.email, t("imp"), true)]);
    // The owner's own impersonation cookie, set by hand, changes nothing: still the owner.
    jar().set("nashr_impersonate", u.email);
    await taskRoute.PATCH(json("/api/tasks/own", "PATCH", { status: "approved", by: { kind: "system", job: "cron" } }), params({ id: "own" }));
    await settle();

    // The founder, signed in to their own account, starts support access through the console exactly as the button does.
    const founder = await newUser("by-founder");
    vi.stubEnv("ADMIN_EMAILS", founder.email);
    try {
      await signIn(founder.email);
      const res = await adminUser.POST(json(`/api/admin/users/x`, "POST", { action: "impersonate" }), params({ email: encodeURIComponent(u.email) }));
      expect(res.status).toBe(200);
      await taskRoute.PATCH(json("/api/tasks/imp", "PATCH", { status: "rejected", note: "no", by: { kind: "owner", email: u.email } }), params({ id: "imp" }));
      await settle();
    } finally {
      vi.unstubAllEnvs();
    }

    const [imp, own] = await listDecisions(u.email);
    expect(own).toMatchObject({ task: "own", action: "approve", by: OWNER(u) });
    // Who impersonated comes from the session the console wrote: the founder's own email.
    expect(imp).toMatchObject({ task: "imp", action: "reject", by: { kind: "founder", email: u.email, imp: founder.email } });
  });
});

describe("a governance save that changes something is kept, once (rule 194)", () => {
  it("names what changed as dotted paths; off equals unset for auto-approve and null equals unset for a cap", () => {
    const after: Governance = { ...DEFAULT_GOV, autoApprove: { social: true, ads: false }, weeklyCap: 30, reviewer: false, agentCaps: { razan: 5 } };
    expect(govDiff(DEFAULT_GOV, after)).toEqual(["autoApprove.social", "weeklyCap", "reviewer", "agentCaps.razan"]);
    expect(govDiff(DEFAULT_GOV, { ...DEFAULT_GOV, autoApprove: { social: false } })).toEqual([]);
    expect(govDiff({ ...DEFAULT_GOV, agentCaps: { noor: 3 } }, { ...DEFAULT_GOV, agentCaps: { noor: 4 } })).toEqual(["agentCaps.noor"]);
    expect(govDiff({ ...DEFAULT_GOV, agentCaps: { noor: 3 } }, DEFAULT_GOV)).toEqual(["agentCaps.noor"]);
  });

  it("one revision per real change, with the session's `by`; the panel's full re-save adds nothing and writes nothing", async () => {
    const u = await owner("hist-put");
    const first = await put({ ...DEFAULT_GOV, reviewer: false, agentCaps: { razan: 7 }, by: { kind: "system", job: "cron" } });
    expect(first.status).toBe(200);
    expect(first.body.entry!.changes.map((c) => c.path)).toEqual(["reviewer", "agentCaps.razan"]);
    const [rev] = await listGovHistory(u.email);
    expect(rev).toMatchObject({ id: first.body.entry!.id, by: OWNER(u), changed: ["reviewer", "agentCaps.razan"], before: DEFAULT_GOV });
    expect(rev.after).toEqual(await getGov(u.email));
    expect(rev.id).toMatch(/^[a-f0-9]{12}$/);

    // What the panel sends on every Save: the whole object, unchanged. No record, and the stored value is left alone.
    const setSpy = vi.spyOn(db, "set");
    const again = await put({ ...(await getGov(u.email)), agentCaps: { razan: 7, noor: null } });
    expect(again.body).toMatchObject({ ok: true, entry: null });
    expect(setSpy.mock.calls.filter(([k]) => k === `gov:${u.email}`)).toEqual([]);
    setSpy.mockRestore();
    expect(await listGovHistory(u.email)).toHaveLength(1);
  });

  it("two saves at once both land, and each revision's before is the other's after", async () => {
    const u = await newUser("hist-race");
    const by = OWNER(u) as GovRevision["by"];
    const [a, b] = await Promise.all([saveGovAs(u.email, { learning: false }, by), saveGovAs(u.email, { noEmDash: true }, by)]);
    expect(a.ok && b.ok).toBe(true);
    const g = await getGov(u.email);
    expect([g.learning, g.noEmDash], "without the lock the second write erased the first").toEqual([false, true]);
    const [newer, older] = await listGovHistory(u.email);
    expect(newer.before).toEqual(older.after);
  });

  it("while another save holds the lock it answers busy (409) and nothing changes", async () => {
    const u = await owner("hist-busy");
    await db.lock(`govlock:${u.email}`, 10);
    const r = await put({ reviewer: false });
    expect(r).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    expect((await getGov(u.email)).reviewer).toBe(true);
    expect(await listGovHistory(u.email)).toEqual([]);
    await db.unlock(`govlock:${u.email}`);
  });

  it("keeps the newest CAPS.govHistory and skips rows it cannot read", async () => {
    const u = await newUser("hist-rows");
    const by = OWNER(u) as GovRevision["by"];
    await saveGovAs(u.email, { weeklyCap: 1 }, by);
    await db.lpush(`govhist:${u.email}`, "{not json");
    await db.lpush(`govhist:${u.email}`, JSON.stringify({ id: "../../x", at: "2026-09-29T00:00:00.000Z", by, changed: [], before: {}, after: {} }));
    await db.lpush(`govhist:${u.email}`, JSON.stringify({ id: "0123456789ab", at: "yesterday-ish", by, changed: [], before: {}, after: {} }));
    await db.lpush(`govhist:${u.email}`, JSON.stringify({ id: "0123456789ac", at: "2026-09-29T00:00:00.000Z", by: { kind: "admin" }, changed: [], before: {}, after: {} }));
    expect((await listGovHistory(u.email)).map((r) => r.after.weeklyCap)).toEqual([1]);
    expect(CAPS.govHistory).toBe(100);
    expect(await listGovHistory(u.email, 0)).toEqual([]);
  });
});

describe("a restore puts a whole snapshot back through today's checks (rule 195)", () => {
  it("is the owner's alone: a member or an admin gets 403 before the id is even checked, and nothing changes", async () => {
    const u = await owner("rb-role");
    const mine = await put({ reviewer: false });
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(u, role, `rb-${role}`);
      await signIn(m.email);
      expect(await restore(mine.body.entry!.id), role).toEqual({ status: 403, body: { error: "forbidden" } });
      expect((await restore("not-an-id")).status, role).toBe(403);
    }
    expect((await getGov(u.email)).reviewer).toBe(false);
    expect(await listGovHistory(u.email)).toHaveLength(1);
  });

  it("needs a session, a well-formed id and an id from the caller's own history", async () => {
    signOut();
    expect((await restore("aaaaaaaaaaaa")).status).toBe(401);
    const a = await owner("rb-a");
    const mine = await put({ reviewer: false });
    const b = await owner("rb-b");
    for (const bad of ["../govhist", "AAAAAAAAAAAA", 7, null, "a".repeat(13)]) expect((await restore(bad)).body).toEqual({ ok: false, error: "bad_id" });
    // Account A's revision id, posted by B: not found, and neither account's settings move.
    expect(await restore(mine.body.entry!.id)).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect((await getGov(a.email)).reviewer).toBe(false);
    expect(await getGov(b.email)).toEqual(DEFAULT_GOV);
    expect(await listGovHistory(b.email)).toEqual([]);
  });

  it("removes auto-approve types and caps added after the snapshot, records rollbackOf, and deletes no history", async () => {
    const u = await owner("rb-full");
    const one = await put({ autoApprove: { social: true }, agentCaps: { razan: 5 } });
    const two = await put({ autoApprove: { ads: true }, agentCaps: { noor: 7 }, reviewer: false });
    expect((await getGov(u.email)).autoApprove).toEqual({ social: true, ads: true });

    // Back to before `two`: the state `one` left.
    const back = await restore(two.body.entry!.id);
    expect(back.status).toBe(200);
    const g = await getGov(u.email);
    expect(g.autoApprove.ads).toBe(false);
    expect(g.autoApprove.social).toBe(true);
    expect(g.agentCaps, "a cap set after the snapshot must go, not carry forward").toEqual({ razan: 5 });
    expect(g.reviewer).toBe(true);
    expect(back.body.entry).toMatchObject({ rollbackOf: two.body.entry!.id });
    expect(back.body.entry!.changes.map((c) => c.path).sort()).toEqual(["agentCaps.noor", "autoApprove.ads", "reviewer"]);

    // Back to before `one`: the defaults.
    await restore(one.body.entry!.id);
    const d = await getGov(u.email);
    expect(Object.values(d.autoApprove).some(Boolean)).toBe(false);
    expect(d.agentCaps).toEqual({});
    const hist = await listGovHistory(u.email);
    expect(hist.map((r) => r.rollbackOf ?? "-")).toEqual([one.body.entry!.id, two.body.entry!.id, "-", "-"]);
    expect(hist.every((r) => r.by.kind === "owner" && r.by.email === u.email)).toBe(true);

    // Restoring to what is already there changes nothing and records nothing.
    expect((await restore(one.body.entry!.id)).body).toMatchObject({ ok: true, entry: null });
    expect(await listGovHistory(u.email)).toHaveLength(4);
  });

  it("re-validates an old snapshot and gives a setting it lacks its default, not the current value", async () => {
    const u = await owner("rb-validate");
    await put({ learning: false, weeklyCap: 5 });
    // An old record: out-of-range and unknown values, and no `learning` at all.
    const old = { id: "0123456789ab", at: "2026-09-01T00:00:00.000Z", by: OWNER(u), changed: ["weeklyCap"], after: DEFAULT_GOV,
      before: { autoApprove: { social: true, constructor: true, hacker: true }, weeklyCap: 999, reviewer: true, noEmDash: false, notifyMinutes: -5, agentCaps: { razan: 1e9, hacker: 3, noor: Number.NaN } } };
    await db.lpush(`govhist:${u.email}`, JSON.stringify(old));
    expect((await restore(old.id)).status).toBe(200);
    const g = await getGov(u.email);
    expect(g.weeklyCap).toBe(200);
    expect(g.notifyMinutes).toBe(0);
    expect(g.agentCaps).toEqual({ razan: AGENT_CAP_MAX });
    expect(g.autoApprove.social).toBe(true);
    expect(Object.keys(g.autoApprove).every((k) => k !== "constructor" && k !== "hacker")).toBe(true);
    expect(g.learning, "a setting missing from an old snapshot takes its default").toBe(true);
  });

  it(`is limited to ${GOV_ROLLBACKS_PER_HOUR} an hour per account`, async () => {
    await owner("rb-rate");
    for (let i = 0; i < GOV_ROLLBACKS_PER_HOUR; i++) expect((await restore("bad")).status).toBe(400);
    expect(await restore("0123456789ab")).toEqual({ status: 429, body: { ok: false, error: "slow_down" } });
  });

  it("rollbackGov refuses a malformed id before reading", async () => {
    const u = await newUser("rb-lib");
    const spy = vi.spyOn(db, "lrange");
    expect(await rollbackGov(u.email, "x", OWNER(u) as GovRevision["by"])).toEqual({ ok: false, error: "not_found" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the Governance page shows the history from the server (rule 196)", () => {
  async function render(lang: "ar" | "en") {
    const el = await Page({ params: Promise.resolve({ lang }) });
    return new Response(await renderToReadableStream(el)).text();
  }

  it("newest first: when, who, what changed from what to what, and a Restore button per change", async () => {
    await owner("page-hist");
    await put({ reviewer: false });
    await put({ agentCaps: { razan: 12 } });
    const html = await render("en");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const hist = html.slice(html.indexOf('id="gov-history"'));
    expect(hist).toContain("Change history");
    const arrow = (label: string, from: string, to: string) => new RegExp(`<span dir="auto">${label}</span>: <bdi>${from}</bdi> (<!-- -->)?→(<!-- -->)? <bdi[^>]*>${to}</bdi>`);
    expect(hist).toMatch(arrow("Monthly cap: Razan", "No cap", "12"));
    expect(hist).toMatch(arrow("Second reviewer", "On", "Off"));
    expect(hist.indexOf("Monthly cap: Razan"), "newest first").toBeLessThan(hist.indexOf("Second reviewer"));
    expect((hist.match(/>Owner</g) ?? []).length).toBe(2);
    expect((hist.match(/>Restore</g) ?? []).length).toBe(2);
    const time = /<time id="(gov-rev-[a-f0-9]{12})" dateTime="\d{4}-\d{2}-\d{2}T[^"]+">[^<]+<!-- --> UTC<\/time>/.exec(hist);
    expect(time).not.toBeNull();
    // Each Restore button names the change it undoes by its time, for a screen reader.
    expect(hist).toContain(`aria-describedby="${time![1]}"`);
  });

  it("the list never outgrows what the server keeps, and a change it has dropped says so instead of 'try again'", async () => {
    const u = await owner("page-hist-cap");
    const el = (await Page({ params: Promise.resolve({ lang: "en" }) })) as { props: { historyCap?: number } };
    // The panel trims its own list to this after each save or restore (GovernancePanel `applySaved`).
    expect(el.props.historyCap).toBe(CAPS.govHistory);
    // One change more than the cap: the oldest leaves the server's history, and restoring it is 404 not_found.
    const first = await put({ weeklyCap: 1 });
    for (let i = 0; i < CAPS.govHistory; i++) expect((await saveGovAs(u.email, { weeklyCap: i % 2 ? 1 : 2 }, OWNER(u) as GovRevision["by"])).ok).toBe(true);
    expect((await listGovHistory(u.email)).some((r) => r.id === first.body.entry!.id)).toBe(false);
    expect(await restore(first.body.entry!.id)).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    for (const lang of ["ar", "en"] as const) expect(appDict[lang].governance.restoreGone, lang).not.toBe(appDict[lang].governance.restoreFailed);
  });

  it("an admin and a member see the same history, with no Restore button (only the owner restores)", async () => {
    const u = await owner("page-hist-team");
    await put({ reviewer: false });
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(u, role, `page-hist-${role}`);
      await signIn(m.email);
      const hist = (await render("en")).split('id="gov-history"')[1] ?? "";
      expect(hist, role).toMatch(/<span dir="auto">Second reviewer<\/span>/);
      expect(hist, role).not.toContain(">Restore<");
    }
  });

  it("a change made through support access reads as Nashr support: no page prop or response carries who impersonated", async () => {
    const founder = "founder@test.example";
    const u = await owner("page-hist-imp");
    await signIn(u.email, { imp: founder });
    const saved = await put({ reviewer: false });
    const restored = await restore(saved.body.entry!.id);
    // The history itself keeps who impersonated, for the founder's side.
    const kept = { kind: "founder", email: u.email, imp: founder };
    expect((await listGovHistory(u.email)).map((r) => r.by)).toEqual([kept, kept]);
    const shown = { kind: "founder", email: u.email };
    expect([saved.body.entry!.by, restored.body.entry!.by]).toEqual([shown, shown]);

    // A plain member opens the page: its props, serialized into the page, and the rendered history name support only.
    const m = await newMember(u, "member", "page-hist-imp-m");
    await signIn(m.email);
    const el = (await Page({ params: Promise.resolve({ lang: "en" }) })) as { props: { history: { by: unknown }[] } };
    expect(el.props.history.map((r) => r.by)).toEqual([shown, shown]);
    expect(JSON.stringify(el.props)).not.toContain(founder);
    const hist = (await render("en")).split('id="gov-history"')[1] ?? "";
    expect((hist.match(/>Nashr support</g) ?? []).length).toBe(2);
    expect(hist).not.toContain(founder);
  });

  it("in Arabic, and another account sees none of it", async () => {
    await owner("page-hist-ar");
    await put({ learning: false });
    const ar = await render("ar");
    expect(ar).toContain("سجل التغييرات");
    expect(ar).toContain(">استرجع<");
    await owner("page-hist-other");
    const other = await render("en");
    expect(other).toContain("No changes recorded yet.");
    expect(other).not.toContain(">Restore<");
  });
});

describe("the history goes with the account (rule 199)", () => {
  it("wipeAccount deletes govhist and govlock for every brand", async () => {
    const u = await newUser("hist-wipe");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(u.email, second.id);
    const by = { kind: "member", email: "member@test.example", role: "member" } as GovRevision["by"];
    const saved = await saveGovAs(scope, { reviewer: false }, by);
    await saveGovAs(u.email, { learning: false }, by);
    if (!saved.ok || !saved.revision) throw new Error("not saved");
    await rollbackGov(scope, saved.revision.id, by);
    await db.lock(`govlock:${u.email}`, 10); // a lock left by a request the platform killed
    await wipeAccount(u.email);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]> } }).__nashrMem;
    const left = [...mem.kv.keys(), ...mem.lists.keys()].filter((k) => /^gov(hist|lock)?:/.test(k) && k.includes(u.email));
    expect(left).toEqual([]);
  });
});
