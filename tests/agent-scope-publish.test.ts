import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rules 1410-1411 (agent scope, Part B, Task 7; spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 6, plan R8 and R15): the publish check at both doors and the founder's release.
 *
 * - 1410: `POST /api/publish/[id]` and chat `publish_item` ask `publishScopeCheck` after their own gates and before
 *   `publishOnce`. Enforce: a refusal is 409 `agent_scope_held` (chat: "Not sent: …") and nothing is sent; a classifier
 *   error is 503 `agent_scope_unavailable` (fails closed). Shadow: an error is logged and the item is sent. Off: no call.
 * - 1411: `POST /api/admin/agent-scope/release` (founder only) stores `itemHash` of the item; that exact text then publishes
 *   with no classifier call, and an edit afterwards is checked again. A brand outside the account's list is 400.
 *
 * The classifier is mocked per call (`cls.decide`, `cls.error`); the platform send is mocked as in the other publish tests.
 */
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
const cls = vi.hoisted(() => ({ decide: () => "in" as string, error: null as null | string, calls: [] as { kind: string; text: string; agent: string }[], during: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/agent-scope-classify", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent-scope-classify")>()),
  classify: async (input: { kind: string; text: string; agent: string }) => {
    cls.calls.push(input);
    if (cls.during) await cls.during();
    return cls.error ? { ok: false, error: cls.error } : { ok: true, verdict: cls.decide() };
  },
}));
const published: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: { id: string }, provider: string) => { published.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

import { adminSignIn, jar, json, newUser, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { currentUser, getUser, type User } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { addBrand } from "@/lib/brands";
import { saveConnection } from "@/lib/connectors/store";
import { db } from "@/lib/db";
import { runTool } from "@/lib/chat";
import { AGENT_SCOPE_KEYS, agentScopeRefusalText, agentScopeRetryText, itemHash, type AgentScopeLogEntry, type AgentScopeModes } from "@/lib/agent-scope";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as release from "@/app/api/admin/agent-scope/release/route";

const KEY = "agent-scope-release-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(() => {
  cls.decide = () => "in";
  cls.error = null;
  cls.calls = [];
  cls.during = null;
  published.length = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
});

const modes = (output: AgentScopeModes["output"]): AgentScopeModes => ({ prompt: "on", input: "off", role: "off", output });
const setModes = (m: AgentScopeModes) => db.set(AGENT_SCOPE_KEYS.modes, m);
const day = () => new Date().toISOString().slice(0, 10);
const logOf = async (email: string) => (await db.lrange(AGENT_SCOPE_KEYS.log(day()), 0, -1)).map((r) => JSON.parse(r) as AgentScopeLogEntry).filter((e) => e.email === email);
const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, type: "social", channel: "telegram", title: id, body: "نص المنشور", status, createdAt: new Date().toISOString(), lang: "ar", ...extra });
const publish = async (id: string) => publishRoute.POST(await vjson(`/api/publish/${id}`, "POST", { provider: "telegram" }), { params: Promise.resolve({ id }) });
const edit = async (id: string, editedBody: string) => taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", { editedBody }), { params: Promise.resolve({ id }) });
const releaseCall = (body: Record<string, unknown>) => release.POST(json("/api/admin/agent-scope/release", "POST", body));

async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
  await signIn(u.email);
  return (await currentUser())!;
}

describe("rule 1410: the publish route checks the item before the send", () => {
  it("enforce + refusal: 409 agent_scope_held with the refusal, nothing sent, the item unchanged and publishable after an edit", async () => {
    await setModes(modes("enforce"));
    const u = await owner("asp1");
    await saveTask(u.email, task("p1", "pending"), true);
    cls.decide = () => "off_topic";
    const r = await publish("p1");
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j).toMatchObject({ ok: false, error: "agent_scope_held" });
    expect(j.message).toBe(agentScopeRefusalText("off_topic", "ar", { brand: "", otherBrands: [] }));
    expect(published).toEqual([]);
    expect(cls.calls).toHaveLength(1);
    expect(cls.calls[0]).toMatchObject({ kind: "output", text: "p1\n\nنص المنشور" });
    expect((await getTask(u.email, "p1"))!.status).toBe("pending");
    expect((await logOf(u.email))[0]).toMatchObject({ layer: "output", where: "publish", verdict: "off_topic", mode: "enforce", itemId: "p1" });
    // The owner edits the text and tries again: the new text is checked and goes out.
    cls.decide = () => "in";
    expect((await edit("p1", "نص جديد عن القهوة")).status).toBe(200);
    expect((await publish("p1")).status).toBe(200);
    expect(published).toEqual(["p1"]);
  });
  it("enforce + classifier error: 503 agent_scope_unavailable, nothing sent (fails closed)", async () => {
    await setModes(modes("enforce"));
    const u = await owner("asp2");
    await saveTask(u.email, task("p2", "pending"), true);
    cls.error = "timeout";
    const r = await publish("p2");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: "agent_scope_unavailable", message: agentScopeRetryText("ar") });
    expect(published).toEqual([]);
    expect((await logOf(u.email))[0]).toMatchObject({ verdict: "error", error: "timeout", where: "publish" });
  });
  it("shadow + classifier error or refusal: sent, and logged", async () => {
    await setModes(modes("shadow"));
    const u = await owner("asp3");
    await saveTask(u.email, task("p3", "pending"), true);
    await saveTask(u.email, task("p4", "pending"), true);
    cls.error = "api";
    expect((await publish("p3")).status).toBe(200);
    cls.error = null;
    cls.decide = () => "personal";
    expect((await publish("p4")).status).toBe(200);
    expect(published).toEqual(["p3", "p4"]);
    const log = await logOf(u.email);
    // The log is newest first.
    expect(log.map((e) => [e.itemId, e.verdict, e.mode])).toEqual([["p4", "personal", "shadow"], ["p3", "error", "shadow"]]);
  });
  it("off: no classifier call", async () => {
    await setModes(modes("off"));
    const u = await owner("asp4");
    await saveTask(u.email, task("p5", "pending"), true);
    cls.decide = () => "off_topic";
    expect((await publish("p5")).status).toBe(200);
    expect(cls.calls).toEqual([]);
  });
  it("chat publish_item enforce + refusal: Not sent, publishOnce not reached", async () => {
    await setModes(modes("enforce"));
    const u = await owner("asp5");
    await saveTask(u.email, task("c1", "approved", { decidedAt: new Date().toISOString() }), true);
    cls.decide = () => "pro_advice";
    const out = await runTool(u, "publish_item", { task_id: "c1", provider: "telegram" }, []);
    expect(out).toBe(`Not sent: ${agentScopeRefusalText("pro_advice", "ar", { brand: "", otherBrands: [] })}`);
    expect(published).toEqual([]);
    expect((await getTask(u.email, "c1"))!.published).toBeUndefined();
    expect((await logOf(u.email))[0]).toMatchObject({ where: "chat_publish", verdict: "pro_advice" });
    cls.decide = () => "in";
    expect(await runTool(u, "publish_item", { task_id: "c1", provider: "telegram" }, [])).toMatch(/Published/);
  });
  it("chat publish_item: an edit made while the check runs is not sent (the sent copy must have the checked text)", async () => {
    await setModes(modes("shadow"));
    const u = await owner("asp6");
    await saveTask(u.email, task("c2", "approved", { decidedAt: new Date().toISOString() }), true);
    // The owner edits the approved item (it stays approved) while the classifier is asked.
    cls.during = async () => { cls.during = null; const cur = (await getTask(u.email, "c2"))!; await saveTask(u.email, { ...cur, editedBody: "نص عدّله المالك أثناء الفحص" }); };
    const out = await runTool(u, "publish_item", { task_id: "c2", provider: "telegram" }, []);
    expect(out).toBe("Not published: the owner edited this item a moment ago. Ask again to publish the new text.");
    expect(published).toEqual([]);
    // Asked again, the new text is checked and sent.
    expect(await runTool(u, "publish_item", { task_id: "c2", provider: "telegram" }, [])).toMatch(/Published/);
    expect(cls.calls.at(-1)!.text).toBe("c2\n\nنص عدّله المالك أثناء الفحص");
  });
});

describe("rule 1411: the founder's release", () => {
  beforeEach(() => jar().clear());
  it("founder only: 401 for no session and for the owner", async () => {
    const u = await owner("asr1");
    await saveTask(u.email, task("r0", "pending"), true);
    expect((await releaseCall({ email: u.email, itemId: "r0" })).status).toBe(401);
    jar().clear();
    expect((await releaseCall({ email: u.email, itemId: "r0" })).status).toBe(401);
    expect((await getTask(u.email, "r0"))!.agentScopeRelease).toBeUndefined();
  });
  it("stores the hash and logs; the released text publishes with no classifier call; an edit is checked again", async () => {
    await setModes(modes("enforce"));
    const u = await owner("asr2");
    await saveTask(u.email, task("r1", "pending"), true);
    cls.decide = () => "off_topic";
    expect((await publish("r1")).status).toBe(409);
    await adminSignIn();
    expect((await releaseCall({ email: u.email, itemId: "r1" })).status).toBe(200);
    const t = (await getTask(u.email, "r1"))!;
    expect(t.agentScopeRelease).toMatchObject({ hash: itemHash(t), by: "key" });
    expect(JSON.parse((await db.lrange("admin:log", 0, 0))[0])).toMatchObject({ actor: "key", email: u.email, what: "agent_scope_release", brandId: "default", itemId: "r1" });
    // The owner publishes the released text: no classifier call.
    await signIn(u.email);
    cls.calls = [];
    expect((await publish("r1")).status).toBe(200);
    expect(cls.calls).toEqual([]);
    // A second released item, edited after the release: checked again (one call) and held.
    await saveTask(u.email, task("r2", "pending"), true);
    await adminSignIn();
    expect((await releaseCall({ email: u.email, itemId: "r2" })).status).toBe(200);
    await signIn(u.email);
    expect((await edit("r2", "نص آخر بعد الإفراج")).status).toBe(200);
    cls.calls = [];
    expect((await publish("r2")).status).toBe(409);
    expect(cls.calls).toHaveLength(1);
  });
  it("a brand outside the account's list is 400; a missing account or item 404; a bad body 400", async () => {
    const u = await owner("asr3");
    const added = (await addBrand((await getUser(u.email))!, "Second")) as { id: string };
    await saveTask(u.email, task("r3", "pending"), true);
    await adminSignIn();
    expect((await releaseCall({ email: u.email, brandId: "nope", itemId: "r3" })).status).toBe(400);
    expect((await releaseCall({ email: u.email, brandId: "../x", itemId: "r3" })).status).toBe(400);
    expect((await releaseCall({ email: u.email })).status).toBe(400);
    expect((await releaseCall({ email: u.email, itemId: "a:b" })).status).toBe(400);
    expect((await releaseCall({ email: "nobody-release@test.example", itemId: "r3" })).status).toBe(404);
    // The item lives in the default brand, not in the added one.
    expect((await releaseCall({ email: u.email, brandId: added.id, itemId: "r3" })).status).toBe(404);
    expect((await releaseCall({ email: u.email, itemId: "r3" })).status).toBe(200);
  });
});
