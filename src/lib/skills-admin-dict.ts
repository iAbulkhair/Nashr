import type { AppDict } from "@/lib/app-i18n";

/**
 * The part of the shared dictionary the founder skills console and the instruction editor read (rule 2098). The page picks it
 * on the server and passes it down: the client panel never imports `appDict`, which would put both languages of the whole
 * dictionary (about 220 kB of source) into the browser bundle of that one route.
 */
export type SkillsDict = Pick<AppDict, "agents" | "dialog" | "files" | "generate" | "governance" | "instructions" | "lang">;

export function pickSkillsDict(d: AppDict): SkillsDict {
  return { agents: d.agents, dialog: d.dialog, files: d.files, generate: d.generate, governance: d.governance, instructions: d.instructions, lang: d.lang };
}
