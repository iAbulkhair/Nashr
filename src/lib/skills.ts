import { createHash } from "crypto";
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

/**
 * First 12 hex characters of the text's SHA-256: enough to tell two versions of a prompt apart. Empty text is "none",
 * a value of its own: a playbook that failed to load is not the same prompt as the one that loaded last week.
 */
export const contentHash = (text: string): string => (text ? createHash("sha256").update(text).digest("hex").slice(0, 12) : "none");

const hashes = new Map<string, string>();
/**
 * The version of a playbook as loaded by this process: `contentHash` of `playbook(name)`, cached next to the text so it
 * is what was deployed, computed once. Stamped on tasks and golden results (src/lib/prompt-stamp.ts).
 */
export function playbookHash(name: string): string {
  if (!hashes.has(name)) hashes.set(name, contentHash(playbook(name)));
  return hashes.get(name)!;
}

/** The playbook injected into an agent's system prompt. */
export const skillsBlock = (agent: Agent): string => (agent.skills ? playbook(agent.skills) : "");

/**
 * Only the named `## ` sections of a playbook, each with its heading, in the playbook's own order: a slice for a prompt
 * that needs an agent's rules but not all of its templates (the cross-agent review in noor.ts). A heading the file does
 * not have is skipped; "" when none is found or the file is missing. Pure over the cached text, so it is stable.
 */
export function playbookSection(name: string, headings: readonly string[]): string {
  const want = new Set(headings.map((h) => h.trim().toLowerCase()));
  const out: string[] = [];
  let keep = false;
  for (const line of playbook(name).split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) keep = want.has(h[1].toLowerCase());
    else if (/^#\s/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.join("\n").trim();
}

/** Editorial rubric shared by the reviewer pass (noor.ts) and the judge (judge.ts). */
export const reviewBlock = (): string => {
  const text = playbook("review");
  return text ? `\n\nEDITORIAL PLAYBOOK (apply it; it never overrides the brand file or the task spec)\n${text}` : "";
};
