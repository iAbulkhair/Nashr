import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 4730-4759 (docs/system/tests/4720-v2-team.md): Thakeen v2 phase 3, team chat (C4) and one task owner (C12). It
 * ships off (src/lib/v2-flags.ts); this file switches `TEAM_CHAT` per test through the flags module, so the real route,
 * gates, card tool and owner route run as they will once the switch is flipped, and the off path runs the same code.
 */
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/v2-flags", () => ({
  GATEWAY_MODE: "off",
  RUN_LOG: false,
  MEMORY_V2: false,
  COMPACTION: false,
  PLANS: false,
  QUEUE: false,
  SELF_CHECK: false,
  get TEAM_CHAT() {
    return flag.on;
  },
}));

import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { acct, getUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { listTasks, type Brand } from "@/lib/brand";
import { createConversation, getConversation, touchConversation } from "@/lib/conversations";
import { scopeOf, type ToolCtx } from "@/lib/chat-gates";
import { turnParts } from "@/lib/chat-reply";
import { taskFromItem } from "@/lib/generate-batch";
import {
  NOTE_TOOLS,
  TEAMMATE_TOOL,
  mentionOf,
  noteRefusal,
  runTeammate,
  teamAllows,
  teamRoute,
  teamTools,
  type TeamTurn,
} from "@/lib/team-chat";
import * as convRoute from "@/app/api/conversations/route";

const src = (p: string) => readFileSync(p, "utf8");
const brand: Brand = {
  name: "مقهى الفنجان",
  website: "",
  industry: "مقاهي",
  dialect: "saudi",
  languages: ["ar"],
  tone: "ودود",
  products: "قهوة مختصة",
  audience: "الرياض",
  offers: "",
  competitors: "",
  banned: "",
  preferred: "",
  channels: ["instagram"],
  city: "الرياض",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${sc(u)}`, brand);
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}

type Params = {
  system: string | { text: string }[];
  tools?: { name: string }[];
  messages: { role: string; content: unknown }[];
  output_config?: { format?: unknown };
};
const reply = (text: string) => ({
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 100 },
  content: [{ type: "text", text }],
});
const toolUse = (name: string, input: Record<string, unknown>) => ({
  model: "claude-sonnet-5-5",
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 10 },
  content: [{ type: "tool_use", id: "tu1", name, input }],
});

/** The SDK, replaced: every chat call goes to `chat(params)`; `made` counts clients. */
function sdk(chat: (p: Params) => unknown) {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  claudeOn();
  const made = { n: 0 };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() {
        made.n++;
      }
      beta = { messages: { stream: () => ({ finalMessage: async () => reply("[]") }) } };
      messages = {
        create: async () => reply(JSON.stringify([{ ok: true }])),
        // A classifier call (a forced tool or a JSON format) is not the chat turn.
        stream: (p: Params & { tool_choice?: unknown }) => ({
          finalMessage: async () =>
            p.output_config?.format ? reply("{}") : p.tool_choice ? reply(JSON.stringify([{ ok: true }])) : chat(p),
        }),
      };
    },
  }));
  return made;
}
const sysText = (p: Params) => (typeof p.system === "string" ? p.system : p.system.map((b) => b.text).join("\n"));
type Turn = { ok: boolean; message: { agent?: string; owner?: string; teamCard?: unknown; content: string } };
async function say(text: string, conv: string, agent = "noor"): Promise<Turn> {
  const route = await import("@/app/api/chat/route");
  return (await (await route.POST(json("/api/chat", "POST", { text, conv, agent }))).json()) as Turn;
}

afterEach(() => {
  flag.on = true;
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("@/lib/model");
  vi.unstubAllEnvs();
});

describe("rule 4730: the switch ships off, and off changes nothing", () => {
  it("is a constant false in the shipped module", () => {
    expect(src("src/lib/v2-flags.ts")).toMatch(/export const TEAM_CHAT: boolean = false;/);
  });
  it("off: @Name routes nowhere, no tool changes, the owner route is 404 and nothing is stored on the thread", async () => {
    flag.on = false;
    const seen: Params[] = [];
    sdk((p) => (seen.push(p), reply("تمام")));
    const u = await owner("team-off");
    const c = await createConversation(sc(u), "…", "noor");
    const j = await say("@فارس ما رأيك؟", c.id);
    expect(j.message.agent).toBe("noor");
    expect(j.message.owner).toBeUndefined();
    expect(seen[0].tools?.map((t) => t.name)).toContain("draft_items");
    expect(seen[0].tools?.map((t) => t.name)).not.toContain(TEAMMATE_TOOL.name);
    expect(sysText(seen[0])).not.toContain("Team thread:");
    const rec = await getConversation(sc(u), c.id);
    expect(rec?.members).toBeUndefined();
    expect(rec?.owner).toBeUndefined();
    const res = await convRoute.PUT(json("/api/conversations", "PUT", { id: c.id, owner: "faris" }));
    expect(res.status).toBe(404);
    expect(teamRoute("@فارس", "noor", null)).toEqual({ agent: "noor", owner: "noor", role: "owner" });
    expect(teamTools([TEAMMATE_TOOL], { agent: "faris", owner: "noor", role: "note" })).toEqual([TEAMMATE_TOOL]);
  });
});

describe("rules 4731-4733: who answers a turn", () => {
  it("an @mention names an agent by id or by its Arabic or English name, folded; an email or an unknown word does not", () => {
    expect(mentionOf("@فارس ما رأيك؟")).toBe("faris");
    expect(mentionOf("رأيك يا @Faris")).toBe("faris");
    expect(mentionOf("(@MAJED)")).toBe("majed");
    expect(mentionOf("@layan")).toBe("layan");
    expect(mentionOf("@دانه")).toBe("dana");
    expect(mentionOf("اكتب لـ me@faris.com")).toBeNull();
    expect(mentionOf("@فلان ثم @ريم")).toBe("reem");
    expect(mentionOf("لا أحد")).toBeNull();
  });
  it("the thread's stored owner answers; @Name brings in a note-taker; the page's agent leads a thread with no owner", () => {
    expect(teamRoute("اكتب منشوراً", "noor", null)).toEqual({ agent: "noor", owner: "noor", role: "owner" });
    expect(teamRoute("اكتب منشوراً", "noor", { owner: "razan" })).toEqual({
      agent: "razan",
      owner: "razan",
      role: "owner",
    });
    expect(teamRoute("@فارس رأيك", "noor", { owner: "razan" })).toEqual({
      agent: "faris",
      owner: "razan",
      role: "note",
    });
    expect(teamRoute("@رزان أكملي", "noor", { owner: "razan" })).toEqual({
      agent: "razan",
      owner: "razan",
      role: "owner",
    });
    expect(teamRoute("x", "noor", { owner: "nobody" }).owner).toBe("noor");
  });
  it("on: the named agent answers with its own label, the reply carries the owner, and the thread keeps its members", async () => {
    const seen: Params[] = [];
    sdk((p) => (seen.push(p), reply("ملاحظاتي")));
    const u = await owner("team-route");
    const c = await createConversation(sc(u), "…", "noor");
    const j = await say("@فارس ما رأيك في الأسعار؟", c.id);
    expect(j.message).toMatchObject({ agent: "faris", owner: "noor" });
    expect(sysText(seen[0])).toContain("Team thread: the person named you");
    expect((await getConversation(sc(u), c.id))?.members).toEqual(["faris"]);
    await say("@دانة وأنتِ؟", c.id);
    await say("@فارس مرة أخرى", c.id);
    expect((await getConversation(sc(u), c.id))?.members).toEqual(["faris", "dana"]);
  });
});

describe("rules 4734-4736: a note-taker adds notes and never drafts", () => {
  it("is offered reading tools only and is refused a drafting tool it names anyway: nothing runs, nothing is charged", async () => {
    const seen: Params[] = [];
    sdk(
      (p) => (
        seen.push(p),
        seen.length === 1 ? toolUse("draft_items", { type: "social", count: 1, brief: "منشور" }) : reply("ملاحظة فقط")
      ),
    );
    const u = await owner("team-note");
    const c = await createConversation(sc(u), "…", "noor");
    const j = await say("@فارس اكتب منشوراً واحداً الآن", c.id);
    expect(j.ok).toBe(true);
    for (const t of seen[0].tools ?? []) expect(NOTE_TOOLS.has(t.name), t.name).toBe(true);
    expect(JSON.stringify(seen[1].messages)).toContain("you add notes only");
    expect(await listTasks(sc(u))).toEqual([]);
    expect((await getUser(acct(u)))!.credits).toBe(u.credits);
  });
  it("the gate is code: every tool outside NOTE_TOOLS is refused for a note-taker and allowed for the owner", () => {
    const note: TeamTurn = { agent: "faris", owner: "noor", role: "note" };
    for (const name of [
      "generate_content",
      "draft_items",
      "generate_image",
      "publish_item",
      "update_brand",
      "write_file",
      "import_catalog",
      "make_plan",
      "propose_handoff",
      "propose_teammate",
      "remember",
    ]) {
      expect(teamAllows(note, name), name).toBe(false);
      expect(teamAllows({ ...note, agent: "noor", role: "owner" }, name)).toBe(true);
      expect(teamAllows(undefined, name)).toBe(true);
    }
    expect(noteRefusal("noor")).toContain("Noor owns this request");
    const chat = src("src/lib/chat.ts");
    expect(chat).toContain("out = !teamAllows(opts.team, u.name) ? noteRefusal(opts.team!.owner) : await gatedTool(");
    expect(chat).toContain("const tools = teamTools(toolsFor(agentId, gov.toolPolicy), opts.team);");
  });
});

describe("rules 4737-4741: the owner proposes a teammate on a card, and only a press acts on it", () => {
  const ctx = (o: Partial<ToolCtx> = {}): ToolCtx => ({
    via: "app",
    team: { agent: "noor", owner: "noor", role: "owner" },
    ...o,
  });
  it("checks the card in code: off, MCP, the note-taker, itself, an unknown agent and a second card are refused", async () => {
    const u = await newUser("team-card");
    const actions: string[] = [];
    flag.on = false;
    expect(runTeammate(u, { agent: "faris" }, ctx(), actions)).toMatch(/^Not done/);
    flag.on = true;
    expect(runTeammate(u, { agent: "faris" }, ctx({ via: "mcp" }), actions)).toMatch(/^Not done/);
    expect(
      runTeammate(u, { agent: "faris" }, ctx({ team: { agent: "faris", owner: "noor", role: "note" } }), actions),
    ).toContain("add notes only");
    expect(runTeammate(u, { agent: "noor" }, ctx(), actions)).toMatch(/^Not done/);
    expect(runTeammate(u, { agent: "boss" }, ctx(), actions)).toMatch(/^Not done/);
    expect(actions).toEqual([]);
    expect(runTeammate(u, { agent: "faris", hand_over: true }, ctx(), actions)).toContain("Nothing moved yet");
    expect(runTeammate(u, { agent: "dana" }, ctx(), actions)).toMatch(/^Not done: one teammate card/);
    expect(actions).toEqual(["team:owner:faris"]);
    expect(turnParts(actions, [], []).teamCard).toEqual({ agent: "faris", kind: "owner" });
    expect(turnParts(["team:ask:dana"], [], []).teamCard).toEqual({ agent: "dana", kind: "ask" });
    expect(turnParts(["team:ask:boss", "team:x:dana"], [], []).teamCard).toBeUndefined();
  });
  it("on: the owner is offered the card tool, and its reply carries the card and the owner", async () => {
    const seen: Params[] = [];
    sdk(
      (p) => (
        seen.push(p),
        seen.length === 1 ? toolUse("propose_teammate", { agent: "faris", hand_over: true }) : reply("فارس أنسب لهذا")
      ),
    );
    const u = await owner("team-card-turn");
    const c = await createConversation(sc(u), "…", "noor");
    const j = await say("أريد مراجعة أسعارنا", c.id);
    expect(seen[0].tools?.map((t) => t.name)).toContain(TEAMMATE_TOOL.name);
    expect(sysText(seen[0])).toContain("you own the requests in this thread");
    expect(j.message).toMatchObject({ agent: "noor", owner: "noor", teamCard: { agent: "faris", kind: "owner" } });
    // The card moved nothing: the thread still answers as Noor's.
    expect((await getConversation(sc(u), c.id))?.owner).toBeUndefined();
  });
  it("the chat screen acts only on a press: the ask card fills the box, the owner card calls the owner route", () => {
    const card = src("src/components/app/TeamCard.tsx");
    expect(card).toContain("onClick={() => onAsk(`@${name} `)}");
    expect(card).toContain('void fetch("/api/conversations", {\n      method: "PUT",');
    expect(src("src/components/app/ChatPanel.tsx")).toContain(
      '{m.role === "assistant" && m.teamCard && isAgentId(m.teamCard.agent) && <TeamCard',
    );
  });
});

describe("rules 4742-4748: one owner, moved only by a person", () => {
  it("PUT /api/conversations sets the owner of the caller's own thread, and the next turn answers as that owner", async () => {
    const seen: Params[] = [];
    sdk((p) => (seen.push(p), reply("تمام")));
    const u = await owner("team-own");
    const c = await createConversation(sc(u), "…", "noor");
    const res = await convRoute.PUT(json("/api/conversations", "PUT", { id: c.id, owner: "faris" }));
    expect(res.status).toBe(200);
    expect(await getConversation(sc(u), c.id)).toMatchObject({ owner: "faris", members: ["faris"] });
    const j = await say("اكتب لي خطة", c.id, "noor");
    expect(j.message).toMatchObject({ agent: "faris", owner: "faris" });
    expect(seen[0].tools?.map((t) => t.name)).toContain("draft_items");
  });
  it("refuses a bad agent, another workspace's thread, a viewer and a signed-out caller; nothing is written", async () => {
    const a = await owner("team-own-a");
    const ca = await createConversation(sc(a), "…", "noor");
    expect((await convRoute.PUT(json("/api/conversations", "PUT", { id: ca.id, owner: "boss" }))).status).toBe(400);
    const b = await owner("team-own-b");
    // B names A's thread: B's own scope has no such record.
    expect((await convRoute.PUT(json("/api/conversations", "PUT", { id: ca.id, owner: "faris" }))).status).toBe(404);
    expect(
      (await convRoute.PUT(json("/api/conversations", "PUT", { id: ca.id, owner: "faris", scope: sc(a) }))).status,
    ).toBe(404);
    expect((await getConversation(sc(a), ca.id))?.owner).toBeUndefined();
    const viewer = await newMember(b, "viewer");
    await signIn(viewer.email);
    const cb = await createConversation(sc(b), "…", "noor");
    expect((await convRoute.PUT(json("/api/conversations", "PUT", { id: cb.id, owner: "faris" }))).status).toBe(403);
    await signOut();
    expect((await convRoute.PUT(json("/api/conversations", "PUT", { id: cb.id, owner: "faris" }))).status).toBe(401);
    expect((await getConversation(sc(b), cb.id))?.owner).toBeUndefined();
  });
  it("the owner rides from the turn to every item the batch saves, set in code", async () => {
    const u = await newUser("team-stamp");
    expect(scopeOf({ team: { agent: "noor", owner: "noor", role: "owner" } })).toEqual({ owner: "noor" });
    expect(scopeOf({})).toEqual({});
    const t = taskFromItem(
      { channel: "instagram", title: "t", body: "b" },
      { type: "social", brand, source: "chat", createdAt: new Date().toISOString(), owner: "noor" },
    );
    expect(t.owner).toBe("noor");
    expect(
      taskFromItem(
        { channel: "instagram", title: "t", body: "b" },
        { type: "social", brand, source: "chat", createdAt: new Date().toISOString() },
      ).owner,
    ).toBeUndefined();
    expect(src("src/lib/generate-batch.ts")).toContain("plan: opts.plan, owner: opts.owner, ins }");
    expect(src("src/components/app/Inbox.tsx")).toContain("{x.owner && isAgentId(x.owner) &&");
    // touchConversation adds a member only when passed one (team chat on), each once.
    const c = await createConversation(sc(u), "…", "noor");
    await touchConversation(sc(u), c.id, "x");
    expect((await getConversation(sc(u), c.id))?.members).toBeUndefined();
  });
});
