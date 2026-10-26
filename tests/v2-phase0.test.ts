import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@/lib/auth";
import type { Task } from "@/lib/brand";

/**
 * Rules 4500-4549 (docs/system/tests/4500-v2-phase0.md): Thakeen v2 phase 0, the action gateway in log mode (C1) and the
 * run log (C2). Both ship off (src/lib/v2-flags.ts); this file turns both on through the flags module, so the real
 * `runTool`, `metered` and `publishOnce` paths write what they would write once the switches are flipped. The batch
 * pipeline is a recorder, as in tests/tool-authority.test.ts, so no model is called.
 */
vi.mock("@/lib/v2-flags", () => ({ GATEWAY_MODE: "log", RUN_LOG: true, MEMORY_V2: false, COMPACTION: false, PLANS: false, QUEUE: false, SELF_CHECK: false, TEAM_CHAT: false, RESEARCH: false }));
const g = vi.hoisted(() => ({ batch: 0 }));
vi.mock("@/lib/generate-batch", async (orig) => {
  const real = await orig<typeof import("@/lib/generate-batch")>();
  const { DEFAULT_GOV } = await import("@/lib/governance");
  return {
    ...real,
    generateBatch: async (_u: User, _scope: string, opts: Record<string, unknown>) => {
      g.batch++;
      const t: Task = {
        id: `t${g.batch}`.padEnd(16, "0"),
        type: opts.type as Task["type"],
        channel: "instagram",
        title: "عنوان",
        body: "نص سري",
        status: "pending",
        createdAt: new Date().toISOString(),
        lang: "ar",
      };
      return {
        ok: true,
        tasks: [t],
        credits: 90,
        receipt: { ok: true, credits: 90 },
        cost: 10,
        agent: "noor",
        gov: DEFAULT_GOV,
      };
    },
  };
});

import { newUser, signIn } from "./helpers/session";
import { acct, currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { wsKey, storedScope } from "@/lib/keys";
import { byOf } from "@/lib/actor";
import { runTool, type ToolCtx } from "@/lib/chat";
import { saveGov } from "@/lib/governance";
import {
  AUDIT_KEEP,
  AUDIT_TTL_S,
  decide,
  gatedMcp,
  gatedTool,
  isMismatch,
  readAudit,
  refusedAnswer,
  type AuditRow,
  type GateInput,
} from "@/lib/gateway";
import { MAX_EVENTS, RUNS_KEEP, RUN_TTL_S, getRun, listRuns, replay, runEvent, withRun, type Run } from "@/lib/runs";
import { metered } from "@/lib/metered";
import { publishOnce } from "@/lib/publish-once";
import { wipeAccount } from "@/lib/account";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  // The session's user, with its role (`actor`): the gateway reads the role as runTool does.
  return (await currentUser())!;
}
const turn = (u: User, extra: Partial<ToolCtx> = {}): ToolCtx => ({
  agent: "noor",
  by: byOf(u),
  via: "app",
  proposed: [],
  awayProposed: [],
  instructionProposed: [],
  spendProposed: [],
  ownerMsg: "اكتب منشورا",
  lang: "ar",
  ...extra,
});
const rows = async (u: User) => (await readAudit(sc(u))).reverse();
const base: GateInput = { tool: "generate_content", initiator: "agent", offered: true, roleOk: true, authority: "on" };

afterEach(() => vi.restoreAllMocks());

describe("rule 4500: the gateway's policy table, first match wins", () => {
  it("answers every row from its inputs only", () => {
    expect(decide(base)).toEqual({ verdict: "allow", rule: "default" });
    expect(decide({ ...base, offered: false, roleOk: false })).toEqual({ verdict: "deny", rule: "not_offered" });
    expect(decide({ ...base, roleOk: false, authority: "off" })).toEqual({ verdict: "deny", rule: "role" });
    expect(decide({ ...base, tool: "publish_item", initiator: "mcp", authority: "off" })).toEqual({
      verdict: "deny",
      rule: "mcp_never",
    });
    expect(decide({ ...base, tool: "handoff_note", initiator: "mcp" })).toEqual({ verdict: "deny", rule: "mcp_never" });
    expect(decide({ ...base, authority: "off" })).toEqual({ verdict: "deny", rule: "authority_off" });
    expect(decide({ ...base, tool: "publish_item", authority: "ask" })).toEqual({
      verdict: "ask",
      rule: "person_approved_item",
    });
    expect(decide({ ...base, tool: "publish_item", initiator: "person" })).toEqual({
      verdict: "ask",
      rule: "person_approved_item",
    });
    expect(decide({ ...base, authority: "ask" })).toEqual({ verdict: "ask", rule: "authority_ask" });
    expect(decide({ ...base, tool: "publish_item", initiator: "agent", authority: "off" })).toEqual({
      verdict: "deny",
      rule: "authority_off",
    });
  });
});

describe("rule 4501: off, the gateway and the run log are plain calls, and this release ships them off", () => {
  it("writes nothing and returns the call's own answer", async () => {
    const u = await owner("gw-off");
    const answer = await gatedTool(
      u,
      "generate_content",
      { agent: "noor" },
      async () => "Created 1 social item(s).",
      "off",
    );
    expect(answer).toBe("Created 1 social item(s).");
    const res = new Response(JSON.stringify({ result: { isError: true } }));
    expect(await gatedMcp(u, "list_inbox", "read", async () => res, "off")).toBe(res);
    expect(await withRun({ scope: sc(u), kind: "chat" }, async () => 7, false)).toBe(7);
    expect(await db.lrange(wsKey.audit(sc(u)), 0, -1)).toEqual([]);
    expect(await db.lrange(wsKey.runs(sc(u)), 0, -1)).toEqual([]);
  });

  it("the shipped switches are off and are constants, not request or environment input", () => {
    const flags = src("src/lib/v2-flags.ts");
    expect(flags).toMatch(/export const GATEWAY_MODE: GatewayMode = "off";/);
    expect(flags).toMatch(/export const RUN_LOG: boolean = false;/);
    expect(flags).not.toMatch(/process\.env/);
    expect(flags).toMatch(/export type GatewayMode = "off" \| "log";/);
  });
});

describe("rule 4502: in log mode a check row is written before the call and a done row after, and the answer is unchanged", () => {
  it("writes the check before the call runs, names the initiator, and never changes the answer", async () => {
    const u = await owner("gw-log");
    let seenBefore: AuditRow[] = [];
    const answer = await gatedTool(u, "generate_content", { agent: "noor", via: "app" }, async () => {
      seenBefore = await readAudit(sc(u));
      return "Created 1 social item(s).";
    });
    expect(answer).toBe("Created 1 social item(s).");
    expect(seenBefore).toHaveLength(1);
    expect(seenBefore[0]).toMatchObject({
      phase: "check",
      tool: "generate_content",
      initiator: "agent",
      agent: "noor",
      verdict: "allow",
      rule: "default",
    });
    const [check, done] = await rows(u);
    expect(done).toMatchObject({ phase: "done", id: check.id, outcome: "ran", mismatch: false });
    await gatedTool(u, "write_file", { via: "mcp" }, async () => "Saved.");
    await gatedTool(u, "write_file", {}, async () => "Saved.");
    const all = await rows(u);
    expect(
      all.filter((r) => r.phase === "check").map((r) => (r as Extract<AuditRow, { phase: "check" }>).initiator),
    ).toEqual(["agent", "mcp", "person"]);
  });
});

describe("rule 4503: the audit list keeps names only, is capped and expires", () => {
  it("holds no tool input or answer text, trims to AUDIT_KEEP, refreshes a 30-day TTL and skips an unreadable row", async () => {
    const u = await owner("gw-list");
    const trim = vi.spyOn(db, "ltrim");
    const expire = vi.spyOn(db, "expire");
    await gatedTool(u, "write_file", { agent: "sami" }, async () => "Saved notes.md with the secret plan");
    const raw = (await db.lrange(wsKey.audit(sc(u)), 0, -1)).join("\n");
    expect(raw).not.toContain("secret plan");
    expect(raw).not.toContain("notes.md");
    expect(trim).toHaveBeenCalledWith(wsKey.audit(sc(u)), AUDIT_KEEP);
    expect(expire).toHaveBeenCalledWith(wsKey.audit(sc(u)), AUDIT_TTL_S);
    await db.lpush(wsKey.audit(sc(u)), "{not json");
    expect(await readAudit(sc(u))).toHaveLength(2);
  });
});

describe("rule 4504: a mismatch is a call the old path ran that the gateway would refuse", () => {
  it("is deny + ran only, and the refusal words are read, never rewritten", async () => {
    expect(isMismatch("deny", "ran")).toBe(true);
    expect(isMismatch("deny", "refused")).toBe(false);
    expect(isMismatch("ask", "ran")).toBe(false);
    expect(isMismatch("allow", "refused")).toBe(false);
    expect(refusedAnswer("Not done: the owner switched off generate_content")).toBe(true);
    expect(refusedAnswer("Not published: this item is not approved yet.")).toBe(true);
    expect(refusedAnswer("Unknown tool.")).toBe(true);
    expect(refusedAnswer("Insufficient credits: need 10, have 0.")).toBe(true);
    expect(refusedAnswer("Created 1 social item(s).")).toBe(false);
    const u = await owner("gw-mismatch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Majed's tool is not offered to Noor: the gateway denies it; a fake old path that ran anyway is flagged.
    await gatedTool(u, "propose_handoff", { agent: "noor" }, async () => "Proposed.");
    const [check, done] = await rows(u);
    expect(check).toMatchObject({ verdict: "deny", rule: "not_offered" });
    expect(done).toMatchObject({ outcome: "ran", mismatch: true });
    expect(warn).toHaveBeenCalled();
  });
});

/** runTool as chat() calls it (rule 4516 pins the call site): through the gateway. */
const viaGateway = (u: User, name: string, input: Record<string, unknown>, ctx: ToolCtx) =>
  gatedTool(u, name, ctx, () => runTool(u, name, input, [], [], undefined, ctx));

describe("rule 4505: runTool goes through the gateway, and its real gates and the gateway agree", () => {
  it("records allow/ran for an allowed call and deny/refused for a switched-off one, answers as with the gateway off", async () => {
    const u = await owner("gw-run");
    const ok = await viaGateway(u, "generate_content", { type: "social" }, turn(u));
    expect(ok).toMatch(/^Created 1 social item/);
    await saveGov(sc(u), { toolPolicy: { noor: { produce: "off" } } });
    const off = await viaGateway(u, "generate_content", { type: "social" }, turn(u));
    expect(off).toMatch(/^Not done: the owner switched off generate_content for Noor/);
    const all = await rows(u);
    expect(all.map((r) => (r.phase === "check" ? `${r.verdict}:${r.rule}` : `${r.outcome}:${r.mismatch}`))).toEqual([
      "allow:default",
      "ran:false",
      "deny:authority_off",
      "refused:false",
    ]);
    expect(g.batch).toBe(1);
  });

  it("over MCP publishing is denied by the gateway and refused by runTool: no mismatch", async () => {
    const u = await owner("gw-mcp-pub");
    const out = await viaGateway(u, "publish_item", { task_id: "x", provider: "telegram" }, turn(u, { via: "mcp" }));
    expect(out).toMatch(/^Not published: publishing is done in the Thakeen app/);
    const [check, done] = await rows(u);
    expect(check).toMatchObject({ initiator: "mcp", verdict: "deny", rule: "mcp_never" });
    expect(done).toMatchObject({ outcome: "refused", mismatch: false });
  });
});

describe("rule 4506: an MCP tool call goes through the gateway, its outcome read from the JSON-RPC answer", () => {
  it("reads isError and error objects as refused, a result as ran, and returns the same response", async () => {
    const u = await owner("gw-mcp");
    const res = new Response(JSON.stringify({ result: { content: [] } }));
    expect(await gatedMcp(u, "list_inbox", "read", async () => res)).toBe(res);
    await gatedMcp(
      u,
      "generate_content",
      "generate",
      async () => new Response(JSON.stringify({ result: { isError: true } })),
    );
    await gatedMcp(u, "save_draft", "drafts", async () => new Response(JSON.stringify({ error: { code: -32602 } })));
    const done = (await rows(u))
      .filter((r) => r.phase === "done")
      .map((r) => (r as Extract<AuditRow, { phase: "done" }>).outcome);
    expect(done).toEqual(["ran", "refused", "refused"]);
    expect((await rows(u))[0]).toMatchObject({ phase: "check", initiator: "mcp", verdict: "allow" });
  });

  it("the route wraps every tools/call in the run log and the gateway, after the unknown-tool answer", () => {
    const route = src("src/app/api/mcp/route.ts");
    expect(route).toMatch(
      /if \(!need\) return err\(id, -32602, "Unknown tool"\);\n[\s\S]{0,400}return withRun\(\{ scope: sc\(user\), kind: "mcp", label: name, via: "mcp" \}, \(\) => gatedMcp\(user, name, need, \(\) => callTool\(/,
    );
  });
});

describe("rule 4507: a failure inside the gateway never changes the call", () => {
  it("rethrows the call's own error with an error row, and an audit write failure leaves the answer as it was", async () => {
    const u = await owner("gw-err");
    const boom = new Error("tool broke");
    await expect(
      gatedTool(u, "write_file", {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await rows(u)).at(-1)).toMatchObject({ phase: "done", outcome: "error" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "lpush").mockRejectedValue(new Error("redis down"));
    expect(await gatedTool(u, "write_file", {}, async () => "Saved.")).toBe("Saved.");
  });
});

describe("rule 4510: a run is one record per request; a nested run joins the open one", () => {
  it("keeps one record for a chat turn that runs a batch, rethrows a failure with ok false", async () => {
    const u = await owner("run-one");
    const s = sc(u);
    const out = await withRun({ scope: s, kind: "chat", agent: "noor", via: "app" }, async () => {
      await withRun({ scope: s, kind: "batch", label: "social" }, async () =>
        runEvent({ t: "publish", provider: "telegram", ok: true }),
      );
      return "done";
    });
    expect(out).toBe("done");
    const ids = await db.lrange(wsKey.runs(s), 0, -1);
    expect(ids).toHaveLength(1);
    const run = (await getRun(s, ids[0]))!;
    expect(run).toMatchObject({ v: 1, kind: "chat", agent: "noor", via: "app", ok: true });
    expect(run.events).toHaveLength(1);
    const boom = new Error("x");
    await expect(
      withRun({ scope: s, kind: "mcp", label: "ask_noor" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const [latest] = await listRuns(s, 1);
    expect(latest).toMatchObject({ kind: "mcp", label: "ask_noor", ok: false });
    runEvent({ t: "publish", provider: "x", ok: true });
    expect(await db.lrange(wsKey.runs(s), 0, -1)).toHaveLength(2);
  });
});

describe("rule 4511: the run index is capped and expires; a missing record is skipped", () => {
  it("trims to RUNS_KEEP with a 30-day TTL on record and index", async () => {
    const u = await owner("run-index");
    const s = sc(u);
    const set = vi.spyOn(db, "set");
    const trim = vi.spyOn(db, "ltrim");
    const expire = vi.spyOn(db, "expire");
    await withRun({ scope: s, kind: "chat" }, async () => 1);
    expect(set.mock.calls.find(([k]) => String(k).startsWith(`run:${s}:`))?.[2]).toBe(RUN_TTL_S);
    expect(trim).toHaveBeenCalledWith(wsKey.runs(s), RUNS_KEEP);
    expect(expire).toHaveBeenCalledWith(wsKey.runs(s), RUN_TTL_S);
    await db.lpush(wsKey.runs(s), "gone");
    expect(await listRuns(s)).toHaveLength(1);
  });
});

describe("rule 4512: every metered model call is a step, with tokens and never words", () => {
  it("records a finished and a failed stream", async () => {
    const u = await owner("run-model");
    const s = sc(u);
    const reply = {
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      content: [{ type: "text", text: "كلمات سرية" }],
    };
    await withRun({ scope: s, kind: "chat" }, async () => {
      await metered({ finalMessage: async () => reply }, { email: acct(u), kind: "chat", agent: "noor" });
      await metered(
        {
          finalMessage: async () => {
            throw new Error("aborted");
          },
          currentMessage: { ...reply, usage: { input_tokens: 40, output_tokens: 1 } },
        },
        { email: acct(u), kind: "chat" },
      ).catch(() => {});
    });
    const [run] = await listRuns(s, 1);
    expect(run.events.map((e) => e.t === "model" && [e.model, e.in, e.ok])).toEqual([
      ["claude-sonnet-5-5", 150, true],
      ["claude-sonnet-5-5", 40, false],
    ]);
    expect(JSON.stringify(run)).not.toContain("كلمات");
  });
});

describe("rule 4513: a publish attempt is a step with the platform and the answer's code", () => {
  it("records not_found for an item that does not exist", async () => {
    const u = await owner("run-pub");
    const s = sc(u);
    await withRun({ scope: s, kind: "chat" }, async () => {
      await publishOnce(s, "nope", "telegram");
    });
    const [run] = await listRuns(s, 1);
    expect(run.events).toEqual([
      expect.objectContaining({ t: "publish", provider: "telegram", ok: false, error: "not_found" }),
    ]);
  });
});

describe("rule 4514: a run replays in order with its totals", () => {
  it("sorts steps by time and sums tokens, calls and refusals", () => {
    const run: Run = {
      v: 1,
      id: "r",
      kind: "chat",
      startedAt: "",
      ms: 9,
      ok: true,
      dropped: 0,
      events: [
        { t: "tool", at: 5, tool: "generate_content", outcome: "refused", ms: 1 },
        { t: "model", at: 1, model: "m", kind: "chat", in: 10, out: 2, ok: true },
        { t: "model", at: 7, model: "m", kind: "chat", in: 5, out: 1, ok: false },
        { t: "publish", at: 8, provider: "x", ok: true },
      ],
    };
    const r = replay(run);
    expect(r.steps.map((e) => e.at)).toEqual([1, 5, 7, 8]);
    expect(r).toMatchObject({
      tokens: { in: 15, out: 3 },
      modelCalls: 2,
      failedModelCalls: 1,
      toolCalls: 1,
      refusedTools: 1,
      publishes: 1,
    });
  });
});

describe("rule 4515: deleting the account deletes its runs and audit list", () => {
  it("leaves no run record, index or audit row", async () => {
    const u = await owner("run-wipe");
    const s = sc(u);
    await withRun({ scope: s, kind: "chat" }, async () => gatedTool(u, "write_file", {}, async () => "Saved."));
    const [id] = await db.lrange(wsKey.runs(s), 0, -1);
    await wipeAccount(acct(u));
    expect(await getRun(s, id)).toBeNull();
    expect(await db.lrange(wsKey.runs(s), 0, -1)).toEqual([]);
    expect(await db.lrange(wsKey.audit(s), 0, -1)).toEqual([]);
  });
});

describe("rule 4516: the entry points open a run and the tool paths go through the gateway", () => {
  it("chat, generateBatch, the tool call in chat and publishOnce are wired", () => {
    expect(src("src/lib/chat.ts")).toMatch(
      /return withRun\(\{ scope: sc\(user\), kind: "chat", agent: agentId, via: opts\.via \?\? "app"[^}]*\}, \(\) => chatTurn\(/,
    );
    expect(src("src/lib/generate-batch.ts")).toMatch(
      /withRun\(\{ scope: sc\(user\), kind: "batch", label: opts\.type[^}]*\}, \(\) => runBatch\(/,
    );
    // runTool's one caller in src is the chat turn, and it calls it through the gateway; phase 1's `remember` (rule 4555),
    // phase 2's `make_plan` (rule 4626) and phase 3's `propose_teammate` (rule 4738) run from the same call, inside the same
    // gatedTool; a team thread's note-taker (rule 4735) is refused before it.
    expect(src("src/lib/chat.ts")).toMatch(
      /out = !teamAllows\(opts\.team, u\.name\) \? noteRefusal\(opts\.team!\.owner\) : await gatedTool\(user, u\.name, ctx, \(\) => \(u\.name === TEAMMATE_TOOL\.name \? Promise\.resolve\(runTeammate\(user, [^)]*\)\) : u\.name === REMEMBER_TOOL\.name \? runRemember\(user, [^)]*\) : u\.name === PLAN_TOOL\.name \? runMakePlan\(user, [^)]*\) : isResearchTool\(u\.name\) \? runResearch\(user, u\.name, [^)]*\) : runTool\(user, u\.name, /,
    );
    expect(src("src/lib/chat.ts").match(/runTool\(/g)).toHaveLength(1);
    expect(src("src/lib/publish-once.ts")).toMatch(/runEvent\(\{ t: "publish", provider, ok: r\.ok/);
    expect(src("src/lib/metered.ts")).toMatch(/runEvent\(modelStep\(to, msg\.model, msg\.usage, true\)\)/);
  });
});

describe("rule 4517: the new keys are workspace keys of the registry", () => {
  it("builds run, runs and audit from a Scope", () => {
    const S = storedScope("a@x.test#b1");
    expect([wsKey.run(S, "r1"), wsKey.runs(S), wsKey.audit(S)]).toEqual([
      "run:a@x.test#b1:r1",
      "runs:a@x.test#b1",
      "audit:a@x.test#b1",
    ]);
  });
});

describe("rule 4518: a run keeps at most MAX_EVENTS steps and counts the rest", () => {
  it("drops past the cap", async () => {
    const u = await owner("run-cap");
    const s = sc(u);
    await withRun({ scope: s, kind: "chat" }, async () => {
      for (let i = 0; i < MAX_EVENTS + 5; i++) runEvent({ t: "publish", provider: "x", ok: true });
    });
    const [run] = await listRuns(s, 1);
    expect(run.events).toHaveLength(MAX_EVENTS);
    expect(run.dropped).toBe(5);
  });
});
