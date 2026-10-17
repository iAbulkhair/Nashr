import type { Lang } from "./i18n";
import { arShell, enShell } from "./app-i18n-shell";
import { arWorkspace, enWorkspace } from "./app-i18n-workspace";
import { arPages, enPages } from "./app-i18n-pages";
import { arTodo, enTodo } from "./app-i18n-todo";
import { arTeam, enTeam } from "./app-i18n-team";

/** The parts are joined in their original key order; each part's English is checked against its Arabic, and the whole against the whole. */
const ar = {
  ...arShell,
  ...arWorkspace,
  ...arPages,
  ...arTodo,
  ...arTeam,
};

const en: typeof ar = {
  ...enShell,
  ...enWorkspace,
  ...enPages,
  ...enTodo,
  ...enTeam,
};

export const appDict: Record<Lang, typeof ar> = { ar, en };
export type AppDict = typeof ar;
