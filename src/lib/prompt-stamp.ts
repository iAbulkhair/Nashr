/**
 * Which prompts made an item: a short hash of every source that shapes a batch, stamped on each task by `taskFromItem`
 * (src/lib/generate-batch.ts) and on every golden result (src/lib/golden.ts).
 *
 * A prompt changes in two places. The playbooks are content (content/skills/*.md, one per agent, plus review.md shared
 * by the reviewer and the judge); the rest is code: the owning agent's own system prompt (`fixedPrompt`: persona, RULES,
 * OUTPUT FORMAT), the task spec (SPECS in noor.ts), the reviewer's checks for the owning agent (`reviewerRubric`), the
 * judge's rubric (`JUDGE_RUBRIC`) and the industry playbooks (playbooks.ts). Hashing
 * only content/skills would read "unchanged" after a change made in code, so each source has its own hash:
 * `skills` (the owning agent's playbook and its paid ads slice from ads.md), `review` (review.md), `industry` (`id:hash`, when the brand is known) and
 * `code`. A missing playbook hashes to "none", which never equals a loaded one.
 */
import type { Brand, Task } from "./brand";
import { AGENTS, agentForTask } from "./agents";
import { contentHash, playbookHash, skillsHash } from "./skills";
import { pickPlaybook } from "./playbooks";
import { fixedPrompt, playbookBlock, reviewerRubric, taskSpec } from "./noor";
import { JUDGE_RUBRIC } from "./judge";
import type { TaskType } from "./tasks";

export type PromptStamp = NonNullable<Task["pb"]>;

const codeHashes = new Map<TaskType, string>();
/** Stands in for the skills playbook inside `fixedPrompt`: the playbook is hashed on its own (`skills`). */
const SKILLS_HASHED_APART = "[skills playbook: hashed apart]";
/**
 * The prompts for `type` written in code: its agent's system prompt (persona, RULES, OUTPUT FORMAT), its task spec, the
 * reviewer's checks for its agent and the judge's rubric.
 */
export function codeHash(type: TaskType): string {
  if (!codeHashes.has(type)) codeHashes.set(type, contentHash([fixedPrompt(agentForTask(type), SKILLS_HASHED_APART), taskSpec(type), reviewerRubric(type), JUDGE_RUBRIC].join("\n\u0000\n")));
  return codeHashes.get(type)!;
}

const industryHashes = new Map<string, string>();
/** The industry playbook a brand's batches get, as `id:hash` ("general" when no playbook matches its industry). */
export function industryStamp(brand: Pick<Brand, "industry">): string {
  const id = pickPlaybook(brand.industry)?.id ?? "general";
  if (!industryHashes.has(id)) industryHashes.set(id, `${id}:${contentHash(playbookBlock(brand))}`);
  return industryHashes.get(id)!;
}

/** The stamp for one batch of `type`. `industry` is left out when the brand's industry is not known. */
export function promptStamp(type: TaskType, brand?: Partial<Pick<Brand, "industry">>): PromptStamp {
  const agent = agentForTask(type);
  const industry = typeof brand?.industry === "string" ? industryStamp({ industry: brand.industry }) : undefined;
  return { skills: agent.skills ? skillsHash(agent) : "none", review: playbookHash("review"), ...(industry ? { industry } : {}), code: codeHash(type) };
}

/** Every agent playbook's hash and review.md's, by file name, plus `code:<type>` for each of `types`: a golden run's versions. */
export function promptHashes(types: readonly TaskType[]): Record<string, string> {
  const names = [...new Set(AGENTS.flatMap((a) => (a.skills ? [a.skills] : []))), "ads", "review"];
  return Object.fromEntries([...names.map((n) => [n, playbookHash(n)] as const), ...[...new Set(types)].map((t) => [`code:${t}`, codeHash(t)] as const)]);
}
