import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Rule 951: customer instructions never decide an approval, a publish or a spend. The code that approves, publishes,
 * charges credits or applies the governance caps does not import the instruction modules, so no instruction (and no
 * model reading one) can switch a gate off. Files are listed by name: a new one that gates something is added here.
 * The files that do import them are prompt builders or storage and are not gates: src/lib/chat.ts, src/lib/media/start.ts,
 * src/lib/media/prompts.ts, src/lib/generate-batch.ts, src/lib/judge.ts (reads the workspace rules into the judge's
 * prompt; it can only move an item back to pending), src/lib/noor.ts, src/lib/golden.ts (the prompts they build), and
 * src/lib/account.ts, src/lib/activity.ts, src/lib/brand.ts, src/lib/entitlements.ts (wipe keys, activity kind, limits).
 * src/lib/roles.ts (who may) and src/lib/mcp.ts (the connected-app token path) are pinned too: a role or a token never reads an instruction.
 * generate-batch.ts, media/start.ts, chat.ts, noor.ts, judge.ts and golden.ts import agent-instructions for prompt text
 * only (accepted deviation from spec 6 item 5); the last test pins exactly that set. Spend and brand-change code is
 * pinned as well (media jobs, X stats, brand proposals and the brand routes, chat allowance and budget, the schedule), and
 * the proposal, reference-file and HTTP helper modules are forbidden for all of them like the store and the renderer.
 */
const GATES = [
  "src/app/api/publish/[id]/route.ts", // POST publish
  "src/app/api/tasks/[id]/route.ts", // approve / reject / edit a task
  "src/app/api/secretary/meeting/[id]/approve/route.ts",
  "src/lib/publish-once.ts",
  "src/lib/connectors/publish.ts",
  "src/lib/brand-rules.ts", // gateTask: the banned-words and claims check before approve and publish
  "src/lib/decisions.ts",
  "src/lib/task-version.ts",
  "src/lib/secretary-meeting.ts",
  "src/lib/credits.ts",
  "src/lib/governance.ts",
  "src/lib/roles.ts",
  "src/lib/mcp.ts",
  "src/lib/media/jobs.ts", // media jobs: the spend of a render
  "src/lib/x-stats.ts", // X stats: owner credits
  "src/lib/brand-proposals.ts", // a brand change is applied here
  "src/app/api/brand/route.ts",
  "src/app/api/brand/proposals/[id]/route.ts",
  "src/lib/chat-allowance.ts",
  "src/lib/chat-budget.ts",
  "src/lib/schedule.ts",
  // Line notes (rule 2492): the revision's charge and save; the instructions reach the prompt through noor.reviseDraft only.
  "src/lib/revise.ts",
  "src/app/api/tasks/[id]/revise/route.ts",
];
const FORBIDDEN = ["agent-instructions", "instructions-store", "instructions-safety", "instruction-proposals", "instruction-refs", "instructions-http"];
const importsOf = (src: string) => [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);

describe("rule 951: instructions are not a gate", () => {
  for (const file of GATES) {
    it(`rule 951: ${file} imports none of the instruction modules`, () => {
      const specs = importsOf(readFileSync(join(process.cwd(), file), "utf8"));
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.filter((s) => FORBIDDEN.some((f) => s.includes(f)))).toEqual([]);
    });
  }

  it("rule 951: the scan sees an instruction import when there is one (it is not blind)", () => {
    const sample = `import { x } from "@/lib/agent-instructions";\nconst y = await import("./instructions-store");`;
    expect(importsOf(sample).filter((s) => FORBIDDEN.some((f) => s.includes(f)))).toEqual(["@/lib/agent-instructions", "./instructions-store"]);
    // And it does see it in a file that really has one.
    const real = importsOf(readFileSync(join(process.cwd(), "src/lib/chat.ts"), "utf8"));
    expect(real.some((s) => s.includes("agent-instructions"))).toBe(true);
  });

  it("rule 951: the prompt builders that sit next to a spend (generate-batch, media/start) and the writers import agent-instructions and nothing else of the instruction modules", () => {
    for (const file of ["src/lib/generate-batch.ts", "src/lib/media/start.ts", "src/lib/noor.ts", "src/lib/judge.ts", "src/lib/golden.ts"]) {
      const hits = importsOf(readFileSync(join(process.cwd(), file), "utf8")).filter((s) => FORBIDDEN.some((f) => s.includes(f)));
      expect([file, hits.map((h) => h.replace(/^.*\//, ""))]).toEqual([file, ["agent-instructions"]]);
    }
  });
});
