import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Rule 951: customer instructions never decide an approval, a publish or a spend. The code that approves, publishes,
 * charges credits or applies the governance caps does not import the instruction modules, so no instruction (and no
 * model reading one) can switch a gate off. Files are listed by name: a new one that gates something is added here.
 * (src/lib/chat.ts and src/lib/media/start.ts import agent-instructions for prompt building and are not gates.)
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
];
const FORBIDDEN = ["agent-instructions", "instructions-store", "instructions-safety"];
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
});
