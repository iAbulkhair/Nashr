import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 2010-2015 (wave 2a, file splits). src/lib/secretary.ts, src/lib/chat.ts and src/lib/app-i18n.ts were cut into
 * cohesive modules with no behaviour change. The original paths still export exactly what they exported before (the lists
 * below were captured from main at 50ff790b), the modules form a one-way graph, and nothing grows back into one file.
 */
const read = (p: string) => readFileSync(p, "utf8");
const lib = (n: string) => `src/lib/${n}.ts`;

const SECRETARY_PARTS = ["secretary-keys", "secretary-zone", "secretary-input", "secretary-mutate", "secretary-store", "secretary-change", "secretary-read", "secretary-owner", "secretary-tools"];
const CHAT_PARTS = ["chat-history", "chat-tools", "chat-prompt", "chat-reply", "chat-gates", "chat-run-tool"];
const I18N_PARTS = ["app-i18n-shell", "app-i18n-workspace", "app-i18n-pages", "app-i18n-todo", "app-i18n-team"];

/** The value exports of `src/lib/secretary.ts` on main before the split (types are checked by the type-check). */
const SECRETARY_EXPORTS = ["OWNER_ALIASES", "OWNER_ONLY", "REMIND_DAY_AT", "SEC_ALERTS_PER_DAY", "SEC_CREATE_PER_DAY", "SEC_ID", "SEC_KEYS", "SEC_OPEN_MAX", "SEC_PURGE_BATCH", "SEC_READS_PER_HOUR", "SEC_TOOL_DEFS", "SEC_TOOL_NAMES", "SEC_WRITES_PER_HOUR", "SERIES_ID", "SNOOZE_PRESETS", "SPAWN_CLAIM_S", "TICK_FRESH_MS", "agendaFor", "audit", "awayMapOf", "backFingerprint", "calFor", "calendarOf", "changeItem", "cleanBlock", "cleanLine", "cleanPhone", "createItem", "factOf", "fail", "fireReminder", "forgetDueScope", "getItem", "isLocalDay", "isSecTool", "isWaNumber", "listDeleted", "listDone", "listOpenItems", "mutateItem", "newSecId", "newSeriesId", "nextWeekStart", "overdueAlertFingerprint", "parseFields", "parseOwnerChange", "parseRepeat", "purgeExpired", "reindexOpen", "remindLine", "removeBySystem", "ruleText", "runSecretaryTool", "secretaryDaily", "secretaryKeys", "snoozePreset", "stateOf", "timedReminders", "todoPage", "toolError", "usableCalendar", "whereShown", "withLock", "zoneFor"];
const CHAT_EXPORTS = ["CHAT_MAX_DURATION_S", "CHAT_MODEL", "CHAT_RENDER_MIN_MS", "CHAT_TOOL_NAMES", "CONTACT_AWAY_TOOL", "EDITABLE_BRAND_FIELDS", "FREE_SLOTS_TOOL", "INSTRUCTION_CARDS_PER_REPLY", "OUT_OF_TIME_REPLY", "PROPOSE_HANDOFF_TOOL", "PROPOSE_MEETING_TASKS_TOOL", "TOOL_ACTION", "chat", "chatRefusedText", "history", "push", "runTool", "statusFor", "system", "toolsFor", "turnParts"];
/** The top-level keys of the in-app dictionary, in their order on main. */
const DICT_KEYS = ["lang", "appName", "nav", "start", "chat", "ux", "handoff", "instructionCard", "files", "library", "governance", "instructions", "activity", "login", "signup", "onboarding", "generate", "tasks", "calendar", "refer", "integrations", "inspo", "inbox", "billing", "agents", "channelNames", "home", "history", "limit", "todo", "notifications", "reports", "team", "join", "readOnly", "dialog", "models"];

/** `./name` modules a file imports or re-exports. */
const localImports = (p: string): string[] => [...read(p).matchAll(/from "\.\/([\w-]+)"/g)].map((m) => m[1]);

describe("rule 2010: the original paths still export the same public names", () => {
  it("src/lib/secretary exports exactly what it did before the split", async () => {
    const mod = await import("@/lib/secretary");
    expect(Object.keys(mod).sort()).toEqual([...SECRETARY_EXPORTS].sort());
  });

  it("src/lib/chat exports exactly what it did before the split", async () => {
    const mod = await import("@/lib/chat");
    expect(Object.keys(mod).sort()).toEqual([...CHAT_EXPORTS].sort());
  });

  it("the re-exports are the very same values as the modules that hold them", async () => {
    const sec = await import("@/lib/secretary");
    const keys = await import("@/lib/secretary-keys");
    const store = await import("@/lib/secretary-store");
    const change = await import("@/lib/secretary-change");
    const tools = await import("@/lib/secretary-tools");
    expect(sec.SEC_KEYS).toBe(keys.SEC_KEYS);
    expect(sec.getItem).toBe(store.getItem);
    expect(sec.changeItem).toBe(change.changeItem);
    expect(sec.runSecretaryTool).toBe(tools.runSecretaryTool);
    const chat = await import("@/lib/chat");
    const run = await import("@/lib/chat-run-tool");
    const prompt = await import("@/lib/chat-prompt");
    expect(chat.runTool).toBe(run.runTool);
    expect(chat.system).toBe(prompt.system);
  });

  it("src/lib/app-i18n exports the dictionary and its type under the same names", () => {
    const src = read(lib("app-i18n"));
    expect(src).toContain("export const appDict: Record<Lang, typeof ar> = { ar, en };");
    expect(src).toContain("export type AppDict = typeof ar;");
    expect([...src.matchAll(/^export (?:const|type) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["AppDict", "appDict"]);
  });
});

describe("rule 2011: the in-app dictionary is the same dictionary, joined from its parts", () => {
  it("has the same top-level keys in the same order, in both languages", async () => {
    const { appDict } = await import("@/lib/app-i18n");
    expect(Object.keys(appDict.ar)).toEqual(DICT_KEYS);
    expect(Object.keys(appDict.en)).toEqual(DICT_KEYS);
  });

  it("joins the parts in order, and types the English against the Arabic as a whole and part by part", () => {
    const main = read(lib("app-i18n"));
    expect(main).toContain("const en: typeof ar = {");
    const order = (re: RegExp) => [...main.matchAll(re)].map((m) => m[1].toLowerCase());
    const names = I18N_PARTS.map((p) => p.replace("app-i18n-", ""));
    expect(order(/^\s+\.\.\.ar(\w+),$/gm)).toEqual(names);
    expect(order(/^\s+\.\.\.en(\w+),$/gm)).toEqual(names);
    for (const p of I18N_PARTS) {
      const n = p.replace("app-i18n-", "");
      const N = n[0].toUpperCase() + n.slice(1);
      const src = read(lib(p));
      expect(src, p).toContain(`export const ar${N} = {`);
      expect(src, p).toContain(`export const en${N}: typeof ar${N} = {`);
    }
  });

  it("holds every key exactly once across the parts", async () => {
    const { appDict } = await import("@/lib/app-i18n");
    const [shell, workspace, pages, todo, team] = await Promise.all([
      import("@/lib/app-i18n-shell"), import("@/lib/app-i18n-workspace"), import("@/lib/app-i18n-pages"),
      import("@/lib/app-i18n-todo"), import("@/lib/app-i18n-team"),
    ]);
    const parts = [shell.arShell, workspace.arWorkspace, pages.arPages, todo.arTodo, team.arTeam];
    expect(parts.flatMap((o) => Object.keys(o))).toEqual(Object.keys(appDict.ar));
  });
});

describe("rule 2012: the original path holds only what it should", () => {
  it("src/lib/secretary.ts only re-exports: no statement but `export … from`", () => {
    const body = read(lib("secretary")).replace(/\/\*[\s\S]*?\*\//g, "");
    const statements = body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
    expect(statements.length).toBeGreaterThan(5);
    for (const l of statements) expect(l, l).toMatch(/^export (type )?\{ [\w, ]+ \} from "\.\/secretary-[a-z]+";$/);
  });

  it("src/lib/chat.ts keeps the turn itself and re-exports the rest", () => {
    const src = read(lib("chat"));
    expect(src).toContain("export async function chat(");
    for (const f of ["system", "runTool", "toolsFor", "history"]) expect(src, f).not.toMatch(new RegExp(`^(export )?(async )?function ${f}\\(`, "m"));
  });
});

describe("rule 2013: the split modules form a one-way graph", () => {
  const graph = (parts: string[]) => Object.fromEntries(parts.map((p) => [p, localImports(lib(p)).filter((d) => parts.includes(d))]));
  const cyclic = (g: Record<string, string[]>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const walk = (n: string, stack: string[]) => {
      if (stack.includes(n)) { out.push([...stack.slice(stack.indexOf(n)), n].join(" > ")); return; }
      if (seen.has(n)) return;
      seen.add(n);
      for (const d of g[n] ?? []) walk(d, [...stack, n]);
    };
    for (const n of Object.keys(g)) walk(n, []);
    return out;
  };

  it("secretary modules do not import each other in a circle, and none imports the barrel", () => {
    expect(cyclic(graph(SECRETARY_PARTS))).toEqual([]);
    for (const p of SECRETARY_PARTS) expect(localImports(lib(p)), p).not.toContain("secretary");
  });

  it("chat modules do not import each other in a circle, and none imports chat.ts", () => {
    expect(cyclic(graph([...CHAT_PARTS, "chat"]))).toEqual([]);
    for (const p of CHAT_PARTS) expect(localImports(lib(p)), p).not.toContain("chat");
  });

  it("the dictionary parts import nothing of each other, and chat-tools and secretary-keys are leaves", () => {
    for (const p of I18N_PARTS) expect(localImports(lib(p)).filter((d) => d.startsWith("app-i18n")), p).toEqual([]);
    expect(localImports(lib("secretary-keys")).filter((d) => d.startsWith("secretary"))).toEqual([]);
    expect(localImports(lib("chat-tools")).filter((d) => d.startsWith("chat"))).toEqual([]);
  });
});

describe("rule 2014: nothing grows back into one file", () => {
  const MAX = 450;
  it(`each split module stays under ${MAX} lines`, () => {
    for (const p of [...SECRETARY_PARTS, ...CHAT_PARTS, ...I18N_PARTS, "chat", "app-i18n", "secretary"]) {
      expect(read(lib(p)).split("\n").length, p).toBeLessThan(MAX);
    }
  });
});

describe("rule 2015: the moved rules are still where their tests say", () => {
  it("the lock, the key registry and the tool gate sit in the modules that name them", () => {
    expect(read(lib("secretary-store"))).toContain("export async function withLock<T>(");
    expect(read(lib("secretary-keys"))).toContain("export const SEC_KEYS = {");
    expect(read(lib("chat-run-tool"))).toContain("export async function runTool(");
    expect(read(lib("chat-gates"))).toContain("async function roleGate(");
    expect(read(lib("chat-prompt"))).toContain("export function system(");
  });
});
