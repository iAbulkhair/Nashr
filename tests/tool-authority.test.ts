import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/auth";
import type { Task } from "@/lib/brand";

/**
 * Rules 2430-2436: agent tool authority, what each agent may do from a conversation (src/lib/tool-authority.ts). The
 * owner sets it in Governance; `toolsFor` stops offering what is off, `runTool` refuses it from the setting read at the
 * call, "ask first" leaves the spend card whatever the owner wrote, and the card's Run checks the setting again.
 * `generateBatch` and `renderImage` are recorders, as in tests/spend-gate.test.ts, so each test sees exactly when a paid
 * pipeline is reached.
 */
const g = vi.hoisted(() => ({ batch: [] as { scope: string; opts: Record<string, unknown> }[], renders: [] as string[] }));
vi.mock("@/lib/generate-batch", async (orig) => {
  const real = await orig<typeof import("@/lib/generate-batch")>();
  const { DEFAULT_GOV } = await import("@/lib/governance");
  return {
    ...real,
    generateBatch: async (_u: User, scope: string, opts: Record<string, unknown>) => {
      g.batch.push({ scope, opts });
      const t: Task = { id: `t${g.batch.length}`.padEnd(16, "0"), type: opts.type as Task["type"], channel: "instagram", title: "عنوان", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
      return { ok: true, tasks: [t], credits: 90, receipt: { ok: true, credits: 90 }, cost: 10, agent: "noor", gov: DEFAULT_GOV };
    },
  };
});
vi.mock("@/lib/media/start", async (orig) => {
  const real = await orig<typeof import("@/lib/media/start")>();
  return { ...real, renderImage: async (_u: User, t: Task) => { g.renders.push(t.id); return { ok: true, placeholder: true, task: t, credits: 100 }; } };
});

import { json, newUser, params, signIn } from "./helpers/session";
import { getUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveTask, type Brand } from "@/lib/brand";
import { byOf } from "@/lib/actor";
import { CHAT_TOOL_NAMES, runTool, toolsFor, type ToolCtx } from "@/lib/chat";
import { DEFAULT_GOV, getGov, govDiff, historyView, restorePatch, saveGov, saveGovAs, type Governance } from "@/lib/governance";
import { getSpendProposal, type SpendProposal } from "@/lib/spend-proposals";
import { ASKABLE, CAP_TOOLS, TOOL_CAPS, authorityOf, capOfTool, fullPolicy, mergePolicy, policyNote } from "@/lib/tool-authority";
import { AGENT_IDS } from "@/lib/agents";
import * as spendRoute from "@/app/api/chat/spend/[id]/route";
import * as govRoute from "@/app/api/governance/route";
import { workspaceView } from "@/lib/admin-workspace";

type Body = Record<string, unknown>;
const decide = async (id: string, body: unknown) => {
  const res = await spendRoute.POST(json(`/api/chat/spend/${id}`, "POST", body), params({ id }));
  return { status: res.status, body: (await res.json()) as Body };
};
const brand = (): Brand => ({ name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: new Date().toISOString() } as Brand);
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, brand());
  await signIn(u.email);
  return (await getUser(u.email))!;
}
const turn = (u: User, ownerMsg: string, extra: Partial<ToolCtx> = {}): ToolCtx & { spendProposed: SpendProposal[] } => ({ agent: "noor", by: byOf(u), via: "app", proposed: [], awayProposed: [], instructionProposed: [], spendProposed: [], ownerMsg, lang: "ar", ...extra });
const ASKED = "اكتب لي 10 منشورات لليوم الوطني";

beforeEach(() => { g.batch = []; g.renders = []; });

describe("rule 2430: the policy names real tools and is read and stored only in its checked shape", () => {
  it("every governed tool is a chat tool, and no tool is governed twice", () => {
    const all = TOOL_CAPS.flatMap((c) => CAP_TOOLS[c]);
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) expect(CHAT_TOOL_NAMES).toContain(t);
    expect(capOfTool("read_file")).toBeNull();
    expect(capOfTool("update_brand"), "a brand change is already a card the owner saves").toBeNull();
  });

  it("unknown agents and capabilities, `ask` where no card exists, and `on` are never stored; missing reads as on", () => {
    const p = mergePolicy({ noor: { produce: "ask", publish: "ask", hack: "off" }, ghost: { produce: "off" } }, { sami: { files: "off", images: "ask" }, noor: { catalog: "maybe" } });
    expect(p).toEqual({ noor: { produce: "ask" }, sami: { files: "off", images: "ask" } });
    expect(mergePolicy(p, { noor: { produce: "on" }, sami: { files: null } })).toEqual({ sami: { images: "ask" } });
    expect(authorityOf(undefined, "noor", "publish")).toBe("on");
    expect(authorityOf({ noor: { publish: "ask" } }, "noor", "publish"), "a stored ask on a capability without a card reads as on").toBe("on");
    expect(ASKABLE).toEqual(["produce", "images"]);
    expect(Object.keys(fullPolicy({}))).toEqual([...AGENT_IDS]);
  });
});

describe("rule 2431: a capability switched off is not offered in that agent's turn, and the prompt says why", () => {
  it("toolsFor drops it for that agent only; without a policy the list is whole", () => {
    const policy = { noor: { publish: "off" as const, produce: "off" as const } };
    const names = toolsFor("noor", policy).map((t) => t.name);
    expect(names).not.toContain("publish_item");
    expect(names).not.toContain("generate_content");
    expect(names).not.toContain("draft_items");
    expect(names).toContain("read_file");
    expect(toolsFor("sami", policy).map((t) => t.name)).toContain("publish_item");
    expect(toolsFor("noor").map((t) => t.name)).toContain("publish_item");
    expect(policyNote(policy, "noor")).toContain("Switched off for you by the owner: generate_content, draft_items, publish_item");
    expect(policyNote(policy, "sami")).toBe("");
  });
});

describe("rule 2432: runTool refuses a switched-off tool from the setting read at the call, before any read, charge or write", () => {
  it("off refuses with no batch; switching it back on lets the next call run", async () => {
    const u = await owner("ta-off");
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "off" } } });
    const actions: string[] = [];
    const out = await runTool(u, "generate_content", { type: "social" }, actions, [], undefined, turn(u, ASKED));
    expect(out).toMatch(/^Not done: the owner switched off generate_content for Noor in Governance/);
    expect(g.batch).toHaveLength(0);
    expect(actions).toEqual([]);
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "on" } } });
    expect(await runTool(u, "generate_content", { type: "social" }, [], [], undefined, turn(u, ASKED))).toMatch(/^Created 1 social item/);
    expect(g.batch).toHaveLength(1);
  });

  it("is keyed by the talking agent: Sami's switch never stops Noor; a call with no agent keeps its own answer", async () => {
    const u = await owner("ta-agent");
    await saveGov(sc(u), { toolPolicy: { sami: { files: "off" } } });
    expect(await runTool(u, "write_file", { name: "notes.md", content: "x" }, [], [], undefined, turn(u, "احفظ", { agent: "sami" }))).toMatch(/^Not done: the owner switched off write_file for Sami/);
    expect(await runTool(u, "write_file", { name: "notes.md", content: "x" }, [], [], undefined, turn(u, "احفظ"))).toMatch(/^Saved notes\.md/);
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "off" } } });
    expect(await runTool(u, "generate_content", { type: "article" }, [], [], undefined, { agent: undefined })).toMatch(/^Created 1/);
  });
});

describe("rule 2433: ask first leaves the card whatever the owner wrote, and is refused over MCP", () => {
  it("an explicit request still stores a card with reason ask, and runs nothing", async () => {
    const u = await owner("ta-ask");
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "ask", images: "ask" } } });
    const ctx = turn(u, ASKED);
    const out = await runTool(u, "generate_content", { type: "social", notes: "اليوم الوطني" }, [], [], undefined, ctx);
    expect(out).toMatch(/^Not started: the owner set this to ask first for you in Governance/);
    expect(g.batch).toHaveLength(0);
    expect(await getSpendProposal(sc(u), ctx.spendProposed[0].id)).toMatchObject({ kind: "batch", reason: "ask", agent: "noor" });
    const t: Task = { id: "a1b2c3d4e5f60718", type: "social", channel: "instagram", title: "قهوة", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(sc(u), t);
    expect(await runTool(u, "generate_image", { task_id: t.id }, [], [], undefined, turn(u, "ارسم صورة لهذا المنشور"))).toMatch(/^Not started: the owner set this to ask first/);
    expect(g.renders).toHaveLength(0);
  });

  it("over MCP, and outside a chat turn, nothing is stored and nothing runs", async () => {
    const u = await owner("ta-ask-mcp");
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "ask" } } });
    const ctx = turn(u, ASKED, { via: "mcp" });
    expect(await runTool(u, "generate_content", { type: "social" }, [], [], undefined, ctx)).toMatch(/^Not done: .*ask first for you in Governance, so it runs only from a card/);
    expect(ctx.spendProposed).toHaveLength(0);
    expect(await runTool(u, "generate_content", { type: "social" }, [], [], undefined, { agent: "noor" })).toMatch(/^Not done: .*ask first/);
    expect(g.batch).toHaveLength(0);
  });
});

describe("rule 2434: the card's Run is checked against today's setting, not the one it was made under", () => {
  it("switched off after the card was made: 409 revoked, nothing charged, the card stays open; back on, it runs", async () => {
    const u = await owner("ta-revoke");
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "ask" } } });
    const ctx = turn(u, ASKED);
    await runTool(u, "generate_content", { type: "social" }, [], [], undefined, ctx);
    const id = ctx.spendProposed[0].id;
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "off" } } });
    const r = await decide(id, { decision: "run" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("revoked");
    expect(g.batch).toHaveLength(0);
    expect(await getSpendProposal(sc(u), id)).not.toBeNull();
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "ask" } } });
    expect((await decide(id, { decision: "run" })).status).toBe(200);
    expect(g.batch).toHaveLength(1);
  });
});

describe("rule 2435: Governance stores, records and restores the policy like every other setting", () => {
  it("a record saved before the field existed reads as all on; a save records each changed capability; restore puts it back", async () => {
    const u = await owner("ta-gov");
    await db.set(`gov:${sc(u)}`, { weeklyCap: 5 });
    expect((await getGov(sc(u))).toolPolicy).toEqual({});
    const s = await saveGovAs(sc(u), { toolPolicy: { noor: { publish: "off", produce: "ask" }, razan: { images: "on" } } }, byOf(u));
    if (!s.ok || !s.revision) throw new Error("not saved");
    expect(s.revision.changed).toEqual(["toolPolicy.noor.produce", "toolPolicy.noor.publish"]);
    expect(historyView([s.revision])[0].changes).toEqual([{ path: "toolPolicy.noor.produce", before: "on", after: "ask" }, { path: "toolPolicy.noor.publish", before: "on", after: "off" }]);
    const back = await saveGovAs(sc(u), restorePatch(s.revision.before), byOf(u), s.revision.id);
    if (!back.ok) throw new Error("not restored");
    expect(back.governance.toolPolicy).toEqual({});
    expect(govDiff({ ...DEFAULT_GOV, toolPolicy: { noor: {} } } as Governance, DEFAULT_GOV)).toEqual([]);
  });

  it("PUT /api/governance accepts the page's full map and drops what is not allowed", async () => {
    await owner("ta-put");
    const body = { ...DEFAULT_GOV, toolPolicy: { ...fullPolicy({}), noor: { ...fullPolicy({}).noor, publish: "ask", files: "off" } } };
    const res = await govRoute.PUT(json("/api/governance", "PUT", body));
    const j = (await res.json()) as { governance: Governance };
    expect(j.governance.toolPolicy).toEqual({ noor: { files: "off" } });
  });
});

describe("rule 2460: the founder's read-only workspace view lists each brand's agent limits", () => {
  it("restrictions only, from the brand's own scope; none reads as an empty list", async () => {
    const u = await owner("ta-ws");
    expect((await workspaceView(u.email))?.brands.find((b) => b.id === "default")?.limits).toEqual([]);
    await saveGov(sc(u), { toolPolicy: { noor: { publish: "off", produce: "ask" }, dana: { files: "off" } } });
    const limits = (await workspaceView(u.email))?.brands.find((b) => b.id === "default")?.limits;
    expect(limits).toEqual([{ agent: "noor", cap: "produce", mode: "ask" }, { agent: "noor", cap: "publish", mode: "off" }, { agent: "dana", cap: "files", mode: "off" }]);
  });
});

