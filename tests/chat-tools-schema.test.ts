import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolsFor } from "@/lib/chat";

const AGENTS = ["noor", "sami", "razan", "faris", "dana", "layan", "reem", "majed"] as const;

/** Rule 770: the chat tools are not `strict`; the API refuses a request whose strict tools carry more than 24 optional parameters. */
describe("chat tool schemas (rule 770)", () => {
  it("no agent's turn offers a strict tool", () => {
    for (const a of AGENTS) {
      for (const t of toolsFor(a)) expect((t as { strict?: boolean }).strict, `${a}:${t.name}`).toBeFalsy();
    }
  });

  it("no model call in src/lib turns strict tool use on again", () => {
    const dir = join(process.cwd(), "src/lib");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /^\s*strict:\s*true/m.test(readFileSync(join(dir, f), "utf8")) || /,\s*strict:\s*true\s*\}/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
