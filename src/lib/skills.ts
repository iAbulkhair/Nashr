import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Agent } from "./agents";

const cache = new Map<string, string>();
/** Server-only: a distilled playbook by file name (content/skills/<name>.md). Empty string when missing. */
export function playbook(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const p = join(process.cwd(), "content", "skills", `${name}.md`);
  const text = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  cache.set(name, text);
  return text;
}

/** The playbook injected into an agent's system prompt. */
export const skillsBlock = (agent: Agent): string => (agent.skills ? playbook(agent.skills) : "");

/** Editorial rubric shared by the reviewer pass (noor.ts) and the judge (judge.ts). */
export const reviewBlock = (): string => {
  const text = playbook("review");
  return text ? `\n\nEDITORIAL PLAYBOOK (apply it; it never overrides the brand file or the task spec)\n${text}` : "";
};
