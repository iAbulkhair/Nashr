import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "@/lib/legal";

/**
 * Rules 1414-1415 (agent scope, Part B, Task 9). 1414: source scans that pin where the agent-scope gates sit, so a new caller
 * or a reordered handler fails here before it reaches an owner. 1415: the privacy policy names the agent scope log, what it
 * keeps and for how long, in both languages.
 */
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const read = (p: string) => readFileSync(p, "utf8");
/** The text of one top-level function: from its signature to the next top-level `export`/`function`/`async function`. */
function fnSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n(export |async function |function )/);
  return signature + (end === -1 ? rest : rest.slice(0, end));
}

describe("rule 1414: where the agent-scope gates sit", () => {
  it("chat(): the input gate runs before the first model call", () => {
    const chat = fnSlice(read("src/lib/chat.ts"), "export async function chat(");
    const gate = chat.indexOf('scopeCheck("input"');
    const model = chat.indexOf(".stream(");
    expect([gate, model].every((i) => i > -1)).toBe(true);
    expect(gate).toBeLessThan(model);
  });

  it("every generateBatch caller is listed with a reason; the owner's two doors hand the notes gate, which runs before the charge", () => {
    const CALLERS: Record<string, { n: number; why: string }> = {
      "src/app/api/generate/route.ts": { n: 1, why: "owner notes, gated (notesGate, rule 796)" },
      "src/app/api/mcp/route.ts": { n: 1, why: "owner notes, gated (notesGate, rule 796)" },
      "src/lib/chat.ts": { n: 2, why: "the turn's owner text already passed the chat input gate (rule 794); the tools are role-gated (rule 798)" },
      "src/lib/routines.ts": { n: 1, why: "code notes (routineNote), no owner text (R5)" },
      "src/lib/schedule.ts": { n: 1, why: "code notes (WEEKLY_NOTE), no owner text (R5)" },
      "src/lib/handoffs.ts": { n: 1, why: "Majed's lead brief, model text checked by the output gate on the items (R5)" },
    };
    const found = Object.fromEntries(filesUnder("src").flatMap((f) => {
      const n = (read(f).match(/\bgenerateBatch\(/g) ?? []).length - (f === "src/lib/generate-batch.ts" ? (read(f).match(/function generateBatch\(/g) ?? []).length : 0);
      return n > 0 ? [[f, n]] : [];
    }));
    expect(found).toEqual(Object.fromEntries(Object.entries(CALLERS).map(([f, c]) => [f, c.n])));
    for (const f of ["src/app/api/generate/route.ts", "src/app/api/mcp/route.ts"]) {
      const src = read(f);
      const call = src.slice(src.indexOf("generateBatch("));
      expect(call.slice(0, call.indexOf("\n")), f).toMatch(/notesGate: \{ notes/);
    }
    // generateBatch awaits the shadow checks around runBatch, which holds the gate and the charge.
    const batch = fnSlice(read("src/lib/generate-batch.ts"), "async function runBatch(");
    const gate = batch.indexOf("checkGenerationNotes(");
    const charge = batch.search(/await charge(Once)?\(/);
    expect([gate, charge].every((i) => i > -1)).toBe(true);
    expect(gate, "the notes gate is asked before anything is charged").toBeLessThan(charge);
  });

  it("write tools never take a brand, scope or email from input", () => {
    const tools = fnSlice(read("src/lib/chat.ts"), "export async function runTool(");
    expect(tools.match(/\binput\.(scope|email|brandId|brand)\b/g) ?? []).toEqual([]);
    expect(read("src/app/api/mcp/route.ts").match(/\bargs\.(scope|email|brandId|brand)\b/g) ?? []).toEqual([]);
  });

  it("agent-scope modes are written only by the founder route", () => {
    const literal = filesUnder("src").filter((f) => read(f).includes('"agent-scope:modes"'));
    expect(literal).toEqual(["src/lib/agent-scope.ts"]);
    const writers = filesUnder("src").filter((f) => /db\.set\(\s*AGENT_SCOPE_KEYS\.modes\b/.test(read(f)));
    expect(writers).toEqual(["src/app/api/admin/agent-scope/modes/route.ts"]);
  });

  it("the publish doors ask publishScopeCheck before publishOnce", () => {
    const route = read("src/app/api/publish/[id]/route.ts");
    expect(route.indexOf("publishScopeCheck(")).toBeGreaterThan(-1);
    expect(route.indexOf("publishScopeCheck(")).toBeLessThan(route.indexOf("publishOnce("));
    const tools = fnSlice(read("src/lib/chat.ts"), "export async function runTool(");
    const item = tools.slice(tools.indexOf('case "publish_item"'));
    expect(item.indexOf("publishScopeCheck(")).toBeGreaterThan(-1);
    expect(item.indexOf("publishScopeCheck(")).toBeLessThan(item.indexOf("publishOnce("));
  });
});

describe("rule 1415: the privacy policy names the agent scope log", () => {
  const text = (lang: "ar" | "en", h: string) => LEGAL[lang].privacy.sections.find((s) => s.h === h)?.p.join(" ") ?? "";
  it("English: what we collect and how long it stays", () => {
    expect(text("en", "What we collect")).toContain("Agent scope log: when a request or a reply falls outside what the team works on, we keep the first 200 characters, the agent and the verdict for 31 days, visible to the founder only.");
    expect(text("en", "Retention and deletion")).toContain("The agent scope log deletes itself after 31 days.");
  });
  it("Arabic: the same two sentences", () => {
    expect(text("ar", "البيانات التي نجمعها")).toContain("سجل نطاق الفريق: عندما يخرج طلب أو رد عن عمل الفريق نحفظ أول 200 حرف واسم الموظف والنتيجة لمدة 31 يوماً، ولا يراها إلا المؤسس.");
    expect(text("ar", "الاحتفاظ والحذف")).toContain("يُحذف سجل نطاق الفريق تلقائياً بعد 31 يوماً.");
  });
  it("the privacy date moved with the change; the terms keep their own", () => {
    expect(LEGAL.en.privacy.updated).toBe("Last updated: 2026-10-12");
    expect(LEGAL.ar.privacy.updated).toBe("آخر تحديث: 2026-10-12");
  });
});
