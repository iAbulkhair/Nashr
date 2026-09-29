import { describe, expect, it, vi } from "vitest";
import { json, newUser, params, settle, signIn } from "./helpers/session";
import { getUser, saveUser } from "@/lib/auth";
import { addBrand, scopeFor } from "@/lib/brands";
import { getTask, listLite, listPreferences, saveTask, type Brand, type Task } from "@/lib/brand";
import { CAPS, db } from "@/lib/db";
import { decisionOf, listDecisions, recordDecisions } from "@/lib/decisions";
import { saveConnection } from "@/lib/connectors/store";
import { saveGov } from "@/lib/governance";
import { wipeAccount } from "@/lib/account";
import { createMcpToken } from "@/lib/mcp";
import { runTool } from "@/lib/chat";
import { runWeekly } from "@/lib/schedule";

// No network: publishing is replaced; with no model key every generation takes its mock path.
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_s: string, _t: Task, provider: string) => ({ provider, url: "https://t.me/x/1", status: "published" as const }) }));

import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as generateRoute from "@/app/api/generate/route";
import * as mcpRoute from "@/app/api/mcp/route";

/**
 * Rules 98-101: the owner's decisions on the agents' work are recorded append-only, per brand scope, at the moment
 * they are made (98); only a person's decision is one, so auto-approval never appears (99); the list is capped and goes
 * with the account (100); and every new task keeps what it was asked for and where it came from (101).
 */
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const quality = (score: number, autofail?: string): Task["quality"] => ({ score, dims: { completeness: 80, brand: 80, honesty: 80, language: 80, format: 80 }, notes: "ready", model: "m", at: "2026-09-29T00:00:00.000Z", ...(autofail ? { autofail } : {}) });
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "instagram", title: `title ${id}`, body: "قهوة اليوم من محمصتنا في الرياض مع حليب طازج", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });
const patch = async (id: string, body: unknown) => { const res = await taskRoute.PATCH(json(`/api/tasks/${id}`, "PATCH", body), params({ id })); await settle(); return res; };
const publish = (id: string) => publishRoute.POST(json(`/api/publish/${id}`, "POST", { provider: "telegram" }), params({ id }));
const withBrand = async (prefix: string) => { const u = await newUser(prefix); await db.set(`brand:${u.email}`, brand); await signIn(u.email); return u; };
const rpc = (token: string, name: string, args: Record<string, unknown>) =>
  mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));

describe("decision records (rule 98)", () => {
  it("PATCH approve, reject with a note, edit and reopen each write one record under the caller's scope", async () => {
    const u = await withBrand("dec");
    await Promise.all([
      saveTask(u.email, task("a1", { quality: quality(88) }), true),
      saveTask(u.email, task("r1", { type: "pricing_review", channel: "doc", quality: quality(55, "invented_fact") }), true),
      saveTask(u.email, task("e1", { title: "x".repeat(120) }), true),
    ]);

    expect((await patch("a1", { status: "approved" })).status).toBe(200);
    expect(await listDecisions(u.email)).toEqual([
      // Who decided comes from the session (rule 193): the owner here, with the account's email.
      { task: "a1", agent: "noor", type: "social", channel: "instagram", action: "approve", at: (await getTask(u.email, "a1"))!.decidedAt, title: "title a1", score: 88, by: { kind: "owner", email: u.email } },
    ]);

    await patch("r1", { status: "rejected", note: "  الأرقام غير صحيحة  " });
    const [rej] = await listDecisions(u.email, 1);
    // The agent is the one that owns the type, computed in code: a pricing review is Razan's.
    expect(rej).toMatchObject({ task: "r1", agent: "razan", type: "pricing_review", action: "reject", note: "الأرقام غير صحيحة", score: 55, autofail: "invented_fact" });

    // Edit and approve in one request: two decisions, the edit first, with the light index's own edit measure.
    const edited = "قهوة مختلفة تماماً كتبها المالك بنفسه";
    await patch("e1", { editedBody: edited, status: "approved" });
    const [approve, edit] = await listDecisions(u.email, 2);
    const lite = (await listLite(u.email)).find((l) => l.id === "e1")!;
    expect(edit).toMatchObject({ task: "e1", action: "edit", editPct: lite.editPct });
    expect(edit.editPct).toBeGreaterThan(0);
    expect(edit.title).toHaveLength(80);
    expect(edit).not.toHaveProperty("note");
    expect(approve).toMatchObject({ task: "e1", action: "approve" });

    // Back to pending is a reopen; repeating a status or re-saving the same edit is not a new decision.
    await patch("a1", { status: "pending" });
    await patch("a1", { status: "pending" });
    await patch("e1", { editedBody: edited, status: "approved" });
    await patch("a1", { scheduledFor: "2026-10-01" });
    const all = await listDecisions(u.email);
    expect(all.map((d) => `${d.task}:${d.action}`)).toEqual(["a1:reopen", "e1:approve", "e1:edit", "r1:reject", "a1:approve"]);
  });

  it("keeps the note with the rejection when one request edits and rejects, and caps it at 300 characters", async () => {
    const u = await withBrand("dec-note");
    await saveTask(u.email, task("t1"), true);
    await patch("t1", { editedBody: "نص جديد مختلف عن الأصل", status: "rejected", note: "ن".repeat(400) });
    const [reject, edit] = await listDecisions(u.email);
    expect(reject.action).toBe("reject");
    expect(reject.note).toHaveLength(300);
    expect(edit.action).toBe("edit");
    expect(edit).not.toHaveProperty("note");
  });

  it("is kept when learning is off, while the preference notes are not written", async () => {
    const u = await withBrand("dec-nolearn");
    await saveGov(u.email, { learning: false });
    await saveTask(u.email, task("t1"), true);
    await patch("t1", { status: "rejected", note: "not our tone" });
    expect(await listDecisions(u.email)).toMatchObject([{ task: "t1", action: "reject", note: "not our tone" }]);
    expect(await listPreferences(u.email)).toEqual([]);
  });

  it("still writes the preference notes in parallel when learning is on", async () => {
    const u = await withBrand("dec-learn");
    await saveTask(u.email, task("t1"), true);
    await patch("t1", { editedBody: "نص المالك الجديد كلياً", status: "rejected", note: "too long" });
    expect(await listPreferences(u.email)).toHaveLength(2);
    expect((await db.get<{ content: string }>(`file:${u.email}:preferences.md`))!.content).toContain("Owner rejected a social item (instagram). Reason: too long");
  });

  it("cannot be read or written across accounts, and the request cannot choose the scope", async () => {
    const a = await withBrand("dec-a");
    await saveTask(a.email, task("mine"), true);
    const b = await withBrand("dec-b");
    await saveTask(b.email, task("theirs"), true);

    // B signed in: A's task id does not resolve, and nothing is recorded anywhere.
    expect((await patch("mine", { status: "approved" })).status).toBe(404);
    expect((await publish("mine")).status).toBe(404);
    // Scope-looking fields in the body are ignored: the record lands under B's own scope.
    await patch("theirs", { status: "rejected", note: "no", scope: a.email, email: a.email });
    expect(await listDecisions(a.email)).toEqual([]);
    expect((await listDecisions(b.email)).map((d) => d.task)).toEqual(["theirs"]);
    expect((await getTask(a.email, "mine"))!.status).toBe("pending");
  });

  it("follows the brand the owner has active", async () => {
    const u = await newUser("dec-agency");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(u.email, second.id);
    await db.set(`brand:${scope}`, brand);
    await saveTask(scope, task("s1"), true);
    await signIn(u.email);
    await patch("s1", { status: "approved" });
    expect((await listDecisions(scope)).map((d) => d.task)).toEqual(["s1"]);
    expect(await listDecisions(u.email)).toEqual([]);
  });

  it("publishing a pending item records a publish decision; publishing an approved one adds nothing", async () => {
    const u = await withBrand("dec-pub");
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await Promise.all([saveTask(u.email, task("p1", { quality: quality(91) }), true), saveTask(u.email, task("p2"), true)]);
    expect((await publish("p1")).status).toBe(200);
    const t = (await getTask(u.email, "p1"))!;
    expect(await listDecisions(u.email)).toEqual([{ task: "p1", agent: "noor", type: "social", channel: "instagram", action: "publish", at: t.decidedAt, title: "title p1", score: 91, by: { kind: "owner", email: u.email } }]);
    // Already approved by the owner: the approval was the decision, the publish is not another one.
    await patch("p2", { status: "approved" });
    expect((await publish("p2")).status).toBe(200);
    expect((await publish("p1")).status).toBe(200);
    expect((await listDecisions(u.email)).map((d) => `${d.task}:${d.action}`)).toEqual(["p2:approve", "p1:publish"]);
  });
});

describe("auto-approval is not a decision (rule 99)", () => {
  it("writes nothing when items are created approved or published after auto-approval", async () => {
    const u = await withBrand("dec-auto");
    await saveGov(u.email, { autoApprove: { social: true } });
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    expect(res.status).toBe(200);
    await settle();
    const made = await listLite(u.email);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((l) => l.status === "approved" && !l.decidedAt)).toBe(true);
    expect((await publish(made[0].id)).status).toBe(200);
    expect(await listDecisions(u.email)).toEqual([]);
  });
});

describe("the decision list is bounded and deleted with the account (rule 100)", () => {
  it("keeps the newest CAPS.decisions records, newest first, and clamps the read", async () => {
    const u = await newUser("dec-cap");
    const t = task("c");
    const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
    await recordDecisions(u.email, Array.from({ length: CAPS.decisions + 12 }, (_, i) => decisionOf(t, "approve", at(i))));
    expect(await db.lrange(`decisions:${u.email}`, 0, -1)).toHaveLength(CAPS.decisions);
    const all = await listDecisions(u.email, 10_000);
    expect(all).toHaveLength(CAPS.decisions);
    expect(all[0].at).toBe(at(CAPS.decisions + 11));
    expect(await listDecisions(u.email, 3)).toHaveLength(3);
    expect(await listDecisions(u.email, 0)).toEqual([]);
    expect(await listDecisions(u.email, Number.NaN)).toEqual([]);
  });

  it("skips a row it cannot read instead of failing the whole list", async () => {
    const u = await newUser("dec-bad");
    await recordDecisions(u.email, [decisionOf(task("ok"), "reject", "2026-09-29T00:00:00.000Z")]);
    await db.lpush(`decisions:${u.email}`, "{not json");
    expect((await listDecisions(u.email)).map((d) => d.task)).toEqual(["ok"]);
  });

  it("wipeAccount removes the list of every brand scope", async () => {
    const u = await newUser("dec-wipe");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(u.email, second.id);
    await Promise.all([recordDecisions(u.email, [decisionOf(task("d"), "approve", "2026-09-29T00:00:00.000Z")]), recordDecisions(scope, [decisionOf(task("s"), "reject", "2026-09-29T00:00:00.000Z", { note: "reason" })])]);
    await wipeAccount(u.email);
    expect(await db.lrange(`decisions:${u.email}`, 0, -1)).toEqual([]);
    expect(await db.lrange(`decisions:${scope}`, 0, -1)).toEqual([]);
  });
});

describe("new tasks keep their brief and their source (rule 101)", () => {
  it("the generate route marks its items manual and keeps the owner's notes, once per batch, cut to 500 characters", async () => {
    const u = await withBrand("brief-gen");
    await generateRoute.POST(json("/api/generate", "POST", { type: "whatsapp", notes: `  عرض الخريف ${"م".repeat(600)}` }));
    const made = await listLite(u.email);
    const tasks = (await Promise.all(made.map((l) => getTask(u.email, l.id)))) as Task[];
    expect(tasks.length).toBe(3);
    for (const t of tasks) {
      expect(t.source).toBe("manual");
      expect(t.brief).toHaveLength(500);
      expect(t.brief!.startsWith("عرض الخريف")).toBe(true);
    }
    // Without notes there is no brief, and the source is still set.
    const u2 = await withBrand("brief-none");
    await generateRoute.POST(json("/api/generate", "POST", { type: "article" }));
    const [plain] = await listLite(u2.email);
    const t2 = (await getTask(u2.email, plain.id))!;
    expect(t2.source).toBe("manual");
    expect(t2).not.toHaveProperty("brief");
  });

  it("chat generate_content and draft_items keep the notes and the brief", async () => {
    const u = await withBrand("brief-chat");
    const user = (await getUser(u.email))!;
    await runTool(user, "generate_content", { type: "whatsapp", notes: "رسائل لعملاء رمضان" }, []);
    await runTool(user, "draft_items", { type: "social", count: 1, brief: "منشور للقهوة الباردة" }, []);
    const tasks = (await Promise.all((await listLite(u.email)).map((l) => getTask(u.email, l.id)))) as Task[];
    expect(tasks.filter((t) => t.type === "whatsapp").every((t) => t.source === "chat" && t.brief === "رسائل لعملاء رمضان")).toBe(true);
    expect(tasks.filter((t) => t.type === "social").map((t) => [t.source, t.brief])).toEqual([["chat", "منشور للقهوة الباردة"]]);
  });

  it("MCP generate_content and the weekly plan keep theirs", async () => {
    const u = await withBrand("brief-mcp");
    const token = await createMcpToken(u.email);
    expect((await rpc(token, "generate_content", { type: "gbp", notes: "افتتاح الفرع الجديد" })).status).toBe(200);
    expect(await runWeekly((await getUser(u.email))!)).toMatch(/^ok:/);
    const tasks = (await Promise.all((await listLite(u.email)).map((l) => getTask(u.email, l.id)))) as Task[];
    expect(tasks.filter((t) => t.type === "gbp").every((t) => t.source === "chat" && t.brief === "افتتاح الفرع الجديد")).toBe(true);
    const weekly = tasks.filter((t) => t.type === "weekly_plan");
    expect(weekly.length).toBeGreaterThan(0);
    expect(weekly.every((t) => t.source === "scheduled" && /automatic Sunday plan/.test(t.brief ?? ""))).toBe(true);
  });
});
