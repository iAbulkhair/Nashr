import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server.edge";

// Publishing reaches a platform; here it succeeds at once, or throws `pub.fail`, and nothing leaves the test.
const pub = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/lib/connectors/publish", async (orig) => ({
  ...(await orig<typeof import("@/lib/connectors/publish")>()),
  publishTask: async (_s: string, _t: unknown, provider: string) => {
    if (pub.fail) throw pub.fail;
    return { provider, url: "https://t.me/x/1", status: "published" as const };
  },
}));

import { json, newMember, newUser, params, settle, signIn, signOut, supportAccess } from "./helpers/session";
import { vjson } from "./helpers/version";
import { CAPS, db } from "@/lib/db";
import { currentUser, getUser, saveUser } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { listDecisions } from "@/lib/decisions";
import { addBrand, scopeFor } from "@/lib/brands";
import { saveConnection } from "@/lib/connectors/store";
import { createMcpToken } from "@/lib/mcp";
import { getGov } from "@/lib/governance";
import { ACTIVITY_KINDS, ACTIVITY_VIAS, actSkipKey, listActivity, recordActivity, recordRun, type Activity } from "@/lib/activity";
import { ACTIVITY_EXPORTS_PER_HOUR, ACTIVITY_READS_PER_HOUR } from "@/lib/rate";
import { periodOf, routineSkipKeys } from "@/lib/routines";
import { runTool } from "@/lib/chat";
import type { BrandProposal } from "@/lib/brand-proposals";
import { appDict } from "@/lib/app-i18n";
import { wipeAccount } from "@/lib/account";
import * as listRoute from "@/app/api/activity/route";
import * as exportRoute from "@/app/api/activity/export/route";
import * as govRoute from "@/app/api/governance/route";
import * as rollbackRoute from "@/app/api/governance/rollback/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as proposalRoute from "@/app/api/brand/proposals/[id]/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as adminUser from "@/app/api/admin/users/[email]/route";
import Page from "@/app/[lang]/app/activity/page";

/**
 * Rules 232-240: the per-agent activity log (src/lib/activity.ts). This file pins the store, the owner actions that
 * record without a model, the list and export routes, the page, the founder console and the wipe;
 * tests/activity-sources.test.ts pins the generation, routine and media rows.
 */
const brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
/** An owner with a brand, signed in; the user a request resolves to (`currentUser` sets `actor`, which the role gates need). */
const owner = async (prefix: string) => {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, brand);
  await signIn(u.email);
  return (await currentUser())!;
};
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "pricing_review", channel: "doc", title: "مراجعة الأسعار", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });
const rows = async (scope: string) => (await listActivity(scope, { limit: CAPS.activity })).rows;
const row = (over: Partial<Activity>): Activity => ({ at: new Date().toISOString(), kind: "generated", by: { kind: "owner" }, via: "app", ...over });
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(async () => {
  await settle();
  pub.fail = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  signOut();
});

describe("the log itself: bounded rows, a recorder that never throws, one sorted and filtered read (rule 236)", () => {
  it("keeps only the known fields, at most ten task ids and 200 characters of one-line note", async () => {
    const u = await newUser("act-bound");
    await recordActivity(u.email, [row({ tasks: Array.from({ length: 12 }, (_, i) => `t${i}`), note: `a\nb\u0000${"x".repeat(300)}`, count: Number.NaN, ...({ extra: "dropped" } as object) }), null, false, undefined]);
    const [r] = await rows(u.email);
    expect(r.tasks).toHaveLength(10);
    expect(r.note).toHaveLength(200);
    expect(r.note!.startsWith("a b x")).toBe(true);
    expect(r).not.toHaveProperty("count");
    expect(r).not.toHaveProperty("extra");
    expect(CAPS.activity).toBe(2000);
  });

  it("a failed write is logged and never reaches the caller", async () => {
    const u = await newUser("act-throw");
    vi.spyOn(db, "lpush").mockRejectedValue(new Error("upstash down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordActivity(u.email, [row({})])).resolves.toBeUndefined();
    await expect(recordRun(u.email, { id: "dana_weekly_report", agent: "dana", type: "weekly_report", via: "routine", by: { kind: "system", job: "routine" }, period: "2026-09-27", ttlS: 60 }, "ok:1")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("activity record failed", "Error");
  });

  it("reads newest first whatever the push order, skips unreadable rows, filters, and pages by time without losing a row", async () => {
    const u = await newUser("act-list");
    const t0 = Date.parse("2026-09-29T10:00:00.000Z");
    // Pushed out of order, as parallel lpushes land; two rows share one time.
    await recordActivity(u.email, [
      row({ at: iso(t0 + 3000), agent: "noor", kind: "generated", note: "c" }),
      row({ at: iso(t0 + 1000), agent: "razan", kind: "judged", note: "a" }),
      row({ at: iso(t0 + 4000), agent: "noor", kind: "decision", note: "d" }),
      row({ at: iso(t0 + 2000), agent: "noor", kind: "judged", note: "b1" }),
      row({ at: iso(t0 + 2000), agent: "noor", kind: "autofail", note: "b2" }),
    ]);
    // Rows no writer makes: bad JSON, an unknown kind, via, agent or type, a missing `by`, a bad time, bad field types.
    const bad = [
      "{", JSON.stringify({ ...row({}), kind: "hacked" }), JSON.stringify({ ...row({}), via: "email" }), JSON.stringify({ ...row({}), agent: "zed" }),
      JSON.stringify({ ...row({}), type: "novel" }), JSON.stringify({ at: iso(t0), kind: "generated", via: "app" }), JSON.stringify({ ...row({}), at: "yesterday" }),
      JSON.stringify({ ...row({}), tasks: [1] }), JSON.stringify({ ...row({}), count: "3" }), JSON.stringify({ ...row({}), note: { html: "<b>" } }), JSON.stringify({ ...row({}), media: "audio" }),
    ];
    await Promise.all(bad.map((b) => db.lpush(`activity:${u.email}`, b)));
    // Rows of one time have no order of their own.
    const notes = (await rows(u.email)).map((r) => r.note);
    expect([notes.slice(0, 2), notes.slice(2, 4).sort(), notes[4], notes.length]).toEqual([["d", "c"], ["b1", "b2"], "a", 5]);
    expect((await listActivity(u.email, { agent: "noor", kind: "judged" })).rows.map((r) => r.note)).toEqual(["b1"]);
    expect((await listActivity(u.email, { agent: "sami" })).rows).toEqual([]);
    expect(await listActivity(u.email, { limit: 0 })).toEqual({ rows: [], next: null });

    // A page of 3 ends on the shared time, so it takes both rows of it; the next page starts strictly before it.
    const p1 = await listActivity(u.email, { limit: 3 });
    expect(p1.rows.map((r) => r.note).sort()).toEqual(["b1", "b2", "c", "d"]);
    expect(p1.next).toBe(iso(t0 + 2000));
    const p2 = await listActivity(u.email, { limit: 3, before: p1.next! });
    expect(p2).toEqual({ rows: [expect.objectContaining({ note: "a" })], next: null });
  });

  it("every kind and via has its words in Arabic and English", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(Object.keys(appDict[lang].activity.kinds).sort(), lang).toEqual([...ACTIVITY_KINDS].sort());
      expect(Object.keys(appDict[lang].activity.via).sort(), lang).toEqual([...ACTIVITY_VIAS].sort());
    }
  });
});

describe("the owner's own actions are recorded once, in the caller's scope, with who acted (rule 233)", () => {
  it("a decision on an item: one row with the action, the owning agent, the title and `by` from the session; a founder is the founder", async () => {
    const u = await owner("act-dec");
    await saveTask(u.email, task("d1"), true);
    await saveTask(u.email, task("d2"), true);
    const patch = async (id: string, body: unknown) => taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", body), params({ id }));
    // The impersonation cookies alone, set on the owner's own session, change nothing: still the owner.
    await supportAccess(u.email);
    expect((await patch("d1", { status: "approved" })).status).toBe(200);
    // The founder's support access to this account: the session record the console writes names the founder (`imp`).
    await signIn(u.email, { imp: "support-founder@test.example" });
    expect((await patch("d2", { status: "rejected", note: "too long", by: { kind: "owner" } })).status).toBe(200);
    await settle();
    const got = await rows(u.email);
    expect(got).toHaveLength(2);
    expect(got.find((r) => r.tasks?.[0] === "d1")).toMatchObject({ kind: "decision", agent: "razan", type: "pricing_review", via: "app", outcome: "approve", note: "مراجعة الأسعار", by: { kind: "owner", email: u.email } });
    expect(got.find((r) => r.tasks?.[0] === "d2")).toMatchObject({ kind: "decision", outcome: "reject", by: { kind: "founder", email: u.email, imp: "support-founder@test.example" } });
  });

  it("every publish is one `published` row with the provider, from the app or from chat; a publish never adds a `decision` row", async () => {
    const u = await owner("act-pub");
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(u.email, task("p1", { type: "social", channel: "instagram", title: "عرض الجمعة" }), true);
    // Approved by a person (`decidedAt`): chat publishes nothing that only auto-approval passed (rule 214).
    await saveTask(u.email, task("p2", { type: "social", channel: "instagram", status: "approved", decidedAt: new Date().toISOString() }), true);
    await saveTask(u.email, task("p3", { type: "social", channel: "instagram", status: "approved" }), true);
    expect((await publishRoute.POST(await vjson("/api/publish/p1", "POST", { provider: "telegram" }), params({ id: "p1" }))).status).toBe(200);
    expect(await runTool(u, "publish_item", { task_id: "p2", provider: "telegram" }, [])).toMatch(/^Published/);
    // A publish that did not go out is no row: a repeat refused by `publishOnce` (route and chat), an auto-approved item.
    expect((await publishRoute.POST(await vjson("/api/publish/p1", "POST", { provider: "telegram" }), params({ id: "p1" }))).status).toBe(409);
    expect(await runTool(u, "publish_item", { task_id: "p2", provider: "telegram" }, [])).toMatch(/Not published again/);
    expect(await runTool(u, "publish_item", { task_id: "p3", provider: "telegram" }, [])).toMatch(/approved automatically/);
    const got = await rows(u.email);
    expect(got.map((r) => r.kind)).toEqual(["published", "published"]);
    expect(got.find((r) => r.via === "app")).toMatchObject({ agent: "noor", type: "social", tasks: ["p1"], outcome: "telegram", note: "عرض الجمعة", by: { kind: "owner", email: u.email } });
    expect(got.find((r) => r.via === "chat")).toMatchObject({ agent: "noor", tasks: ["p2"], outcome: "telegram", by: { kind: "owner", email: u.email } });
  });

  it("a post found live after an unknown attempt (`earlier_live`) is one `published` row at the attempt's time, and a pending item's publish decision", async () => {
    const u = await owner("act-earlier");
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(u.email, task("e1", { type: "social", channel: "instagram", title: "عرض الجمعة" }), true);
    const publish = async (body: Record<string, unknown>) => publishRoute.POST(await vjson("/api/publish/e1", "POST", body), params({ id: "e1" }));
    // No answer: it may be live, so nothing is recorded yet.
    pub.fail = new Error("fetch failed");
    expect((await (await publish({ provider: "telegram" })).json()).error).toBe("publish_unknown");
    await settle();
    expect(await rows(u.email)).toEqual([]);
    // The owner's "Publish again" gets "already posted": the first attempt went out, and is recorded now.
    pub.fail = new Error("x_duplicate");
    const res = await publish({ provider: "telegram", again: true });
    expect(res.status).toBe(409);
    const { error, at } = await res.json();
    expect(error).toBe("earlier_live");
    await settle();
    const got = await rows(u.email);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ at, kind: "published", agent: "noor", via: "app", type: "social", tasks: ["e1"], outcome: "telegram", note: "عرض الجمعة", by: { kind: "owner", email: u.email } });
    // The owner's publish approved the pending item when that attempt went out: `decidedAt` and a `publish` decision.
    expect(await getTask(u.email, "e1")).toMatchObject({ status: "approved", decidedAt: at });
    expect(await listDecisions(u.email)).toMatchObject([{ task: "e1", action: "publish", at, by: { kind: "owner", email: u.email } }]);
  });

  it("chat changes to the files: the talking agent and the file name, never the value; a brand change from chat is no row until Save (rule 568)", async () => {
    const u = await owner("act-chat");
    const member = { kind: "member" as const, email: "sara@team.example", role: "member" as const };
    await runTool(u, "update_brand", { field: "tone", value: "=cmd|' /C calc'!A0" }, [], [], undefined, { agent: "sami", by: member });
    await runTool(u, "write_file", { name: "offers.md", content: "# offers" }, [], [], undefined, { agent: "majed", by: member });
    // Outside a chat turn (no context): who is read from the session, and no agent is claimed.
    await runTool(u, "update_brand", { field: "city", value: "جدة" }, []);
    const got = await rows(u.email);
    expect(got.find((r) => r.kind === "file_written")).toMatchObject({ agent: "majed", via: "chat", by: member, note: "offers.md" });
    // update_brand only proposes: the brand file did not change, so there is no brand_changed row.
    expect(got.filter((r) => r.kind === "brand_changed")).toEqual([]);
    expect(JSON.stringify(got)).not.toContain("calc");
  });

  it("a brand change is a row only when the brand file changed: a proposal applied with Save (rule 568)", async () => {
    const u = await owner("act-prop");
    const proposed: BrandProposal[] = [];
    // Proposals change nothing, so they are no rows; neither is a dismissal. Adding banned words is a proposal too.
    expect(await runTool(u, "update_brand", { field: "banned", value: "مضمون، رخيص" }, [], [], undefined, { agent: "noor", proposed })).toMatch(/^Not saved yet/);
    expect(await runTool(u, "update_brand", { field: "offers", value: "خصم 50% على كل شيء" }, [], [], undefined, { agent: "sami", proposed })).toMatch(/^Not saved yet/);
    expect(await rows(u.email)).toEqual([]);
    const decide = (id: string, action: string) => proposalRoute.POST(json(`/api/brand/proposals/${id}`, "POST", { action }), params({ id }));
    expect((await decide(proposed[1].id, "dismiss")).status).toBe(200);
    expect(await rows(u.email)).toHaveLength(0);
    expect((await decide(proposed[0].id, "apply")).status).toBe(200);
    const got = await rows(u.email);
    expect(got).toHaveLength(1);
    // By whoever pressed Save (from the session), for the agent that proposed it; the field's name, never the words.
    expect(got[0]).toMatchObject({ kind: "brand_changed", via: "app", agent: "noor", by: { kind: "owner", email: u.email }, note: "banned" });
    expect(JSON.stringify(got)).not.toContain("رخيص");
  });

  it("a draft saved by a connected app: `external_draft`, no agent, by the token, via MCP, its title kept as text", async () => {
    const u = await owner("act-mcp");
    const token = await createMcpToken(u.email);
    const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_draft", arguments: { type: "social", title: "Summer post", body: "Iced coffee is back." } } }) }));
    const id = (JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text) as { id: string }).id;
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "external_draft", by: { kind: "token", email: u.email }, via: "mcp", type: "social", tasks: [id], count: 1, note: "Summer post" })]);
    expect((await rows(u.email))[0]).not.toHaveProperty("agent");
  });

  it("governance: a save that changed something is `gov_changed` with the changed settings, a no-op is nothing, a restore is `gov_rollback`", async () => {
    const u = await owner("act-gov");
    const put = (b: unknown) => govRoute.PUT(json("/api/governance", "PUT", b));
    const first = (await (await put({ reviewer: false, agentCaps: { razan: 40 } })).json()) as { entry: { id: string } };
    await put({ reviewer: false }); // nothing changes
    expect((await rollbackRoute.POST(json("/api/governance/rollback", "POST", { id: first.entry.id }))).status).toBe(200);
    const got = await rows(u.email);
    expect(got.map((r) => r.kind)).toEqual(["gov_rollback", "gov_changed"]);
    expect(got[1]).toMatchObject({ via: "app", by: { kind: "owner", email: u.email }, count: 2, note: "reviewer, agentCaps.razan" });
    expect(got[0]).toMatchObject({ note: "reviewer, agentCaps.razan" });
  });

  it("a failing log write never fails the action it describes", async () => {
    const u = await owner("act-down");
    const lpush = db.lpush.bind(db);
    vi.spyOn(db, "lpush").mockImplementation((k: string, v: string) => (k.startsWith("activity:") ? Promise.reject(new Error("upstash down")) : lpush(k, v)));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await govRoute.PUT(json("/api/governance", "PUT", { learning: false }))).status).toBe(200);
    expect((await getGov(u.email)).learning).toBe(false);
    await saveTask(u.email, task("x1"), true);
    expect((await taskRoute.PATCH(await vjson("/api/tasks/x1", "PATCH", { status: "approved" }), params({ id: "x1" }))).status).toBe(200);
    await settle();
    expect(await listActivity(u.email)).toEqual({ rows: [], next: null });
  });
});

describe("GET /api/activity and the CSV export read only the caller's own log (rule 237)", () => {
  it("401 without a session; 400 for an unknown agent, kind or cursor; 429 past the hourly reads", async () => {
    signOut();
    expect((await listRoute.GET(json("/api/activity", "GET"))).status).toBe(401);
    expect((await exportRoute.GET()).status).toBe(401);
    const u = await owner("act-guard");
    for (const q of ["agent=zed", "agent=__proto__", "kind=hacked", "before=yesterday", "before=2026-09-29"]) {
      const res = await listRoute.GET(json(`/api/activity?${q}`, "GET"));
      expect(res.status, q).toBe(400);
    }
    await db.set(`rate:activitylist:${u.email}`, ACTIVITY_READS_PER_HOUR);
    const slow = await listRoute.GET(json("/api/activity", "GET"));
    expect([slow.status, ((await slow.json()) as { error: string }).error]).toEqual([429, "slow_down"]);
    await db.set(`rate:activityexport:${u.email}`, ACTIVITY_EXPORTS_PER_HOUR);
    expect((await exportRoute.GET()).status).toBe(429);
  });

  it("pages of 50 with a time cursor, filtered, and never another account's rows whatever the request says", async () => {
    const a = await owner("act-a");
    const t0 = Date.now() - 3600_000;
    await recordActivity(a.email, Array.from({ length: 55 }, (_, i) => row({ at: iso(t0 + i * 1000), agent: i % 2 ? "noor" : "dana", note: `n${i}` })));
    const first = (await (await listRoute.GET(json("/api/activity", "GET"))).json()) as { rows: Activity[]; next: string };
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].note).toBe("n54");
    const rest = (await (await listRoute.GET(json(`/api/activity?before=${encodeURIComponent(first.next)}`, "GET"))).json()) as { rows: Activity[]; next: string | null };
    expect([rest.rows.map((r) => r.note), rest.next]).toEqual([["n4", "n3", "n2", "n1", "n0"], null]);
    const dana = (await (await listRoute.GET(json("/api/activity?agent=dana&kind=generated", "GET"))).json()) as { rows: Activity[] };
    expect(dana.rows.every((r) => r.agent === "dana")).toBe(true);

    const b = await owner("act-b");
    const other = (await (await listRoute.GET(json(`/api/activity?scope=${encodeURIComponent(a.email)}&email=${encodeURIComponent(a.email)}`, "GET"))).json()) as { rows: Activity[] };
    expect(other.rows).toEqual([]);
    const csv = new TextDecoder().decode(await (await exportRoute.GET()).arrayBuffer());
    expect(csv.split("\n")).toHaveLength(1); // the header only
    expect(b.email).not.toBe(a.email);
  });

  it("the export: UTF-8 with a BOM, an attachment, every row, and a formula-like title neutralised", async () => {
    const u = await owner("act-csv");
    const token = await createMcpToken(u.email);
    const evil = '=HYPERLINK("https://evil.example","open")';
    await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_draft", arguments: { type: "social", title: evil, body: "نص المسودة" } } }) }));
    await recordActivity(u.email, [row({ agent: "razan", kind: "render_failed", media: "video", refunded: true, credits: 12, tasks: ["a", "b"], by: { kind: "member", email: "m@team.example", role: "admin" } })]);
    const res = await exportRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="thakeen-activity-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\n");
    expect(lines[0]).toBe("at,agent,kind,type,via,by,by_email,count,credits,outcome,score,autofail,media,refunded,tasks,note");
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.includes("external_draft"))).toContain(`"'=HYPERLINK(""https://evil.example"",""open"")"`);
    expect(lines.find((l) => l.includes("render_failed"))).toContain('"razan","render_failed","","app","member","m@team.example","","12","","","","video","yes","a b",""');
  });
});

describe("support access reaches the account's logins as support, never as which login (rules 225, 237, 238, 239)", () => {
  it("a member reading the list or the page gets the row without `imp`; storage and the founder console keep it", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-0123456789");
    const founder = "support-founder@test.example";
    const u = await owner("act-imp");
    await saveTask(u.email, task("i1"), true);
    // The founder's support access rejects an item: the row is stored with `imp`, the founder's own console login.
    await signIn(u.email, { imp: founder });
    expect((await taskRoute.PATCH(await vjson("/api/tasks/i1", "PATCH", { status: "rejected", note: "no" }), params({ id: "i1" }))).status).toBe(200);
    await settle();
    expect((await rows(u.email)).map((r) => r.by)).toEqual([{ kind: "founder", email: u.email, imp: founder }]);

    // A plain member of the account: GET /api/activity and the page's props (serialized into the page) name support only.
    const m = await newMember(u, "member", "act-imp-m");
    await signIn(m.email);
    const res = await listRoute.GET(json("/api/activity", "GET"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect((JSON.parse(text) as { rows: Activity[] }).rows.map((r) => r.by)).toEqual([{ kind: "founder", email: u.email }]);
    expect(text).not.toContain(founder);
    const el = await Page({ params: Promise.resolve({ lang: "en" }) });
    const props = (el as unknown as { props: { initial: Activity[] } }).props;
    expect(props.initial.map((r) => r.by)).toEqual([{ kind: "founder", email: u.email }]);
    expect(JSON.stringify(props)).not.toContain(founder);
    expect(await new Response(await renderToReadableStream(el)).text()).toContain("Thakeen support");

    // The founder console reads the rows whole.
    const admin = (await (await adminUser.GET(json(`/api/admin/users/x`, "GET", undefined, { "x-admin-key": "test-admin-key-0123456789" }), params({ email: encodeURIComponent(u.email) }))).json()) as { activity: { rows: Activity[] }[] };
    expect(admin.activity[0].rows.map((r) => r.by)).toEqual([{ kind: "founder", email: u.email, imp: founder }]);
  });
});

describe("the Activity page renders the first page on the server (rule 238)", () => {
  const html = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();

  it("one h1, the rows in plain words with who and via, the filters and the download, in Arabic too; another account sees none", async () => {
    const u = await owner("act-page");
    await recordActivity(u.email, [
      row({ agent: "razan", kind: "generated", type: "pricing_review", count: 1, credits: 6, via: "chat" }),
      row({ kind: "external_draft", note: "<script>alert(1)</script>", via: "mcp", by: { kind: "token", email: u.email } }),
    ]);
    const en = await html("en");
    expect(en.match(/<h1\b/g)).toHaveLength(1);
    expect(en).toMatch(/<\/svg>Activity<\/span><\/h1>/);
    expect(en).toContain("Wrote a batch");
    expect(en).toContain("Razan");
    expect(en).toContain("6 credits");
    expect(en).toContain("Connected app");
    expect(en).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(en).not.toContain("<script>alert(1)");
    expect(en).toContain('href="/api/activity/export"');
    expect(en).toContain("All agents");
    const ar = await html("ar");
    expect(ar).toMatch(/<\/svg>النشاط<\/span><\/h1>/);
    expect(ar).toContain("كتب دفعة");

    await owner("act-page-other");
    const other = await html("en");
    expect(other).toContain("No activity recorded yet.");
    expect(other).not.toContain("6 credits");
    expect(other).not.toContain("alert(1)");
  });
});

describe("the founder console shows each brand's latest 100 rows (rule 239)", () => {
  it("GET /api/admin/users/{email} returns the rows per brand, and refuses without the founder key", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-0123456789");
    const u = await newUser("act-admin");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    await recordActivity(u.email, Array.from({ length: 105 }, (_, i) => row({ at: iso(Date.now() - i * 1000), note: `d${i}` })));
    await recordActivity(scopeFor(u.email, second.id), [row({ agent: "sami", kind: "judged", score: 81 })]);
    const get = (h: Record<string, string>) => adminUser.GET(json(`/api/admin/users/x`, "GET", undefined, h), params({ email: encodeURIComponent(u.email) }));
    expect((await get({})).status).toBe(401);
    const body = (await (await get({ "x-admin-key": "test-admin-key-0123456789" })).json()) as { activity: { brand: string; rows: Activity[] }[] };
    expect(body.activity.map((b) => [b.brand, b.rows.length])).toEqual([["default", 100], [second.id, 1]]);
    expect(body.activity[0].rows[0].note).toBe("d0");
    expect(body.activity[1].rows[0]).toMatchObject({ agent: "sami", score: 81 });
  });
});

describe("the log goes with the account (rule 240)", () => {
  it("wipeAccount deletes activity:{s} and the routines' markers for every brand", async () => {
    const u = await newUser("act-wipe");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scopes = [u.email, scopeFor(u.email, second.id)];
    const run = { id: "dana_weekly_report", agent: "dana" as const, type: "weekly_report" as const, via: "routine" as const, by: { kind: "system" as const, job: "routine" as const }, period: periodOf("weekly"), ttlS: 8 * 86400 };
    // A marker lives `periodDays` from the first idle day of its period, so one set on a period's last day is still alive
    // two periods on: Majed's monthly review idle on 31 August lives to 5 October; Dana's report idle on a Saturday lives
    // into the week after next.
    const now = new Date();
    const twoBack = { monthly: periodOf("monthly", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))), weekly: periodOf("weekly", new Date(now.getTime() - 14 * 864e5)) };
    const old = [
      { ...run, period: twoBack.weekly },
      { ...run, id: "majed_monthly_review", agent: "majed" as const, type: "strategy_review" as const, period: twoBack.monthly, ttlS: 35 * 86400 },
    ];
    for (const s of scopes) {
      await recordActivity(s, [row({ by: { kind: "member", email: "sara@team.example", role: "member" }, note: "a title" })]);
      await recordRun(s, run, "idle");
      for (const r of old) await recordRun(s, r, "idle");
    }
    expect(routineSkipKeys(u.email)).toContain(actSkipKey(u.email, "dana_weekly_report", periodOf("weekly")));
    for (const r of old) expect(routineSkipKeys(u.email)).toContain(actSkipKey(u.email, r.id, r.period));
    await wipeAccount(u.email);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]> } }).__nashrMem;
    const left = [...mem.kv.keys(), ...mem.lists.keys()].filter((k) => /^act(ivity|skip):/.test(k) && k.includes(u.email));
    expect(left).toEqual([]);
  });
});
