import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Agent } from "./agents";

/** Server-only: distilled playbook for an agent (content/skills/<file>.md). Empty string when missing. */
const cache = new Map<string, string>();
export function skillsBlock(agent: Agent): string {
  if (!agent.skills) return "";
  if (cache.has(agent.skills)) return cache.get(agent.skills)!;
  const p = join(process.cwd(), "content", "skills", `${agent.skills}.md`);
  const text = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  cache.set(agent.skills, text);
  return text;
}
