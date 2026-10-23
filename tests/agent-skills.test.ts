// Agent skills in .claude/skills (rule 3150).
// Coverage file: docs/system/tests/3150-agent-skills.md
//
// Every skill is a SKILL.md with a name equal to its folder and a one-line
// description, and every repository path written in backticks in it exists,
// so a skill cannot send an agent to a file that was moved or never existed.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SKILLS = join(ROOT, ".claude", "skills");

const EXPECTED = [
  "add-a-feature",
  "add-a-model-or-media-provider",
  "add-a-notification",
  "add-a-payment-provider",
  "add-a-public-page-or-guide",
  "add-a-ui-component",
  "add-a-workspace-scoped-feature",
  "add-an-api-route",
  "add-arabic-and-english-copy",
  "add-or-edit-an-email",
  "change-a-plan-or-price",
  "change-a-stored-shape",
  "change-sign-in",
  "fix-a-red-ci-run",
  "local-setup",
  "release-and-env-vars",
  "review-a-pr",
  "write-a-browser-test",
  "write-a-unit-test",
];

function skillDirs(): string[] {
  return readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());
}

function read(name: string): string {
  return readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
}

/** Repository paths written inside backticks (a path may sit inside a command). */
function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const span of text.matchAll(/`([^`\n]+)`/g)) {
    for (const m of span[1].matchAll(/(?:^|[\s(=])((?:src|tests|docs|scripts|e2e|content)\/[^\s,;)]+)/g)) {
      let p = m[1].replace(/[.:]+$/, "").replace(/:\d+$/, "");
      if (/[<>{}*$]|\.\.\.|NNNN/.test(p)) continue; // placeholder or glob
      p = p.replace(/\/+$/, "");
      out.add(p);
    }
  }
  return [...out];
}

describe("agent skills (rule 3150)", () => {
  it("has the nineteen skills and no stray folders", () => {
    expect(skillDirs().sort()).toEqual([...EXPECTED].sort());
  });

  for (const name of EXPECTED) {
    describe(name, () => {
      it("has a valid name and a one-line description", () => {
        const text = read(name);
        const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
        expect(fm, "front matter").not.toBeNull();
        const body = fm![1];
        expect(/^name: (.+)$/m.exec(body)?.[1].trim()).toBe(name);
        const desc = /^description: (.+)$/m.exec(body)?.[1].trim() ?? "";
        expect(desc.length).toBeGreaterThan(20);
        // one line only: the front matter holds exactly name and description
        expect(body.split("\n").length).toBe(2);
      });

      it("stays short enough to read", () => {
        expect(read(name).split("\n").length).toBeLessThanOrEqual(125);
      });

      it("only names repository paths that exist", () => {
        const missing = pathsIn(read(name)).filter((p) => !existsSync(join(ROOT, p)));
        expect(missing).toEqual([]);
      });

      it("carries no secret-looking value", () => {
        const text = read(name);
        expect(text).not.toMatch(/\b(sk|pk|re|whsec)_[A-Za-z0-9]{16,}/);
        expect(text).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}\s*$/m);
      });
    });
  }
});
