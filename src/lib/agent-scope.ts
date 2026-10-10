import { createHash } from "node:crypto";
import { CAPS, db, pushCapped } from "./db";
import { listBrands } from "./brands";
import { getBrand } from "./brand";
import { classify, type Classified } from "./agent-scope-classify";
import { VERDICTS, isVerdict, type Verdict } from "./agent-scope-verdicts";
import { agentScopeCeiling, countAgentScopeRefusal } from "./rate";
import type { AgentId } from "./agents";
import type { User } from "./auth";

/**
 * Agent scope, Part B (rules 790-808; spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md section 6):
 * four layers keep the agents on marketing, sales, growth, finance and analytics work. This is the pure core every gate
 * uses: the founder's modes, the verdict words, the refusal copy, the log and the hash of an item's text, and `scopeCheck`,
 * the one decision every gate asks for. It holds no model call of its own: `scopeCheck` calls the classifier in
 * agent-scope-classify.ts (rule 791). The verdict words are in the leaf file agent-scope-verdicts.ts, which both files read,
 * so neither imports the other's module back.
 * "Agent scope" is never "scope": `scope` and `sc(u)` already mean the tenant's brand scope.
 */

/** What a layer does. `off` never checks; `shadow` checks and logs but lets everything through; `enforce` refuses. */
export type AgentScopeMode = "off" | "shadow" | "enforce";
/** `prompt` is the scope text in the agents' prompts (on or off); the other three are the layers that call the classifier. */
export type AgentScopeModes = { prompt: "off" | "on"; input: AgentScopeMode; role: AgentScopeMode; output: AgentScopeMode };

/** Every layer starts in shadow: two weeks of logs before anything is refused. Frozen: readers get a copy. */
export const AGENT_SCOPE_DEFAULT_MODES: AgentScopeModes = Object.freeze({ prompt: "on", input: "shadow", role: "shadow", output: "shadow" });

/** `modes` and `evalLast` are single keys (only `POST /api/admin/agent-scope/modes` writes the first); `log` is one list per UTC day. */
export const AGENT_SCOPE_KEYS = {
  modes: "agent-scope:modes",
  evalLast: "agent-scope:eval:last",
  log: (day: string) => `agent-scope:log:${day}`,
} as const;

/** The classifier's answer words live in the leaf file agent-scope-verdicts.ts (no cycle with the classifier); re-exported here unchanged. */
export { VERDICTS, isVerdict, type Verdict };

/**
 * The modes from whatever is stored, field by field: a missing key, a value that is not an object and any bad field give
 * that field its default, so one bad word never turns a layer off or on by accident. Used by the reader and by the
 * founder's route, so what the route stores is what the reader accepts.
 */
export function parseAgentScopeModes(raw: unknown): AgentScopeModes {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = AGENT_SCOPE_DEFAULT_MODES;
  const mode = (v: unknown, fallback: AgentScopeMode): AgentScopeMode => (v === "off" || v === "shadow" || v === "enforce" ? v : fallback);
  return { prompt: o.prompt === "on" || o.prompt === "off" ? o.prompt : d.prompt, input: mode(o.input, d.input), role: mode(o.role, d.role), output: mode(o.output, d.output) };
}

/** The stored modes, or the defaults. Never throws: a Redis error gives the defaults. */
export async function readAgentScopeModes(): Promise<AgentScopeModes> {
  try {
    return parseAgentScopeModes(await db.get(AGENT_SCOPE_KEYS.modes));
  } catch {
    return parseAgentScopeModes(null);
  }
}

/**
 * What a chat route reads before the turn (rule 795): the modes, once per request, and the refusal ceiling, in one
 * `Promise.all`. `slow` names the spent window, and only while the input gate is in `enforce`: in `off` or `shadow` nothing
 * is refused, so nothing is counted and no ceiling applies. The route answers `slow` before `chatRefusal`'s answer and
 * before the chat allowance is touched, and hands `modes` to `chat()` (`ChatOpts.agentScope`). A counter that cannot be read
 * lets the turn through (the input gate fails open); only the error's name is printed.
 */
export async function agentScopePreflight(u: User): Promise<{ modes: AgentScopeModes; slow: "hour" | "day" | null }> {
  const [modes, slow] = await Promise.all([
    readAgentScopeModes(),
    agentScopeCeiling(u).catch((e) => {
      console.error("agent scope ceiling read failed", e instanceof Error ? e.name : "error");
      return null;
    }),
  ]);
  return { modes, slow: modes.input === "enforce" ? slow : null };
}

type Lang = "ar" | "en";
type Names = { brand: string; otherBrands: string[]; classified?: string };
const key = (s: string) => s.trim().toLowerCase();

/**
 * The refusal an owner reads (spec 6.3). Names come from the owner's own brand list, never from the classifier's text:
 * `other_brand` writes the entry of `names.otherBrands` that equals `names.classified` after trim and lowercase, spelled as
 * the list spells it, and anything else reads "another of your brands". An empty brand name reads "your business" /
 * «نشاطك», so no refusal ever says "for .".
 */
export function agentScopeRefusalText(verdict: Exclude<Verdict, "in">, lang: Lang, names: Names): string {
  const ar = lang === "ar";
  const brand = (typeof names.brand === "string" ? names.brand : "").trim() || (ar ? "نشاطك" : "your business");
  switch (verdict) {
    case "other_brand": {
      const wanted = typeof names.classified === "string" ? key(names.classified) : "";
      const hit = wanted ? names.otherBrands.find((n) => typeof n === "string" && key(n) === wanted) : undefined;
      const other = (hit?.trim() ?? "") || (ar ? "علامة أخرى من علاماتك" : "another of your brands");
      return ar ? `هذا الطلب يخص ${other}. انتقل إليها من قائمة العلامات ثم اسأل مرة أخرى.` : `This is about ${other}. Switch to it from the brand menu and ask again.`;
    }
    case "other_business":
      return ar ? "هذا الطلب لنشاط تجاري آخر. أضفه علامةً جديدة أولاً، ثم اسأل مرة أخرى." : "This is for another business. Add it as a new brand first, then ask again.";
    default:
      return ar
        ? `فريق ذكين يعمل على التسويق والمبيعات والنمو والمالية والتحليلات لـ${brand}. لا أستطيع المساعدة في هذا الطلب.`
        : `Thakeen's team works on marketing, sales, growth, finance and analytics for ${brand}. I can't help with this one.`;
  }
}

/** Shown when an account has hit the ceiling of enforced refusals (`agentScopePreflight`). */
export const agentScopeSlowText = (lang: Lang): string =>
  lang === "ar" ? "طلبات كثيرة خارج عمل الفريق. حاول مرة أخرى لاحقاً." : "Too many requests outside what the team works on. Try again later.";
/** Shown when a publish in enforce mode could not be checked (it fails closed). */
export const agentScopeRetryText = (lang: Lang): string =>
  lang === "ar" ? "تعذّر فحص هذا العنصر الآن. حاول مرة أخرى بعد دقيقة." : "This item could not be checked right now. Try again in a minute.";

export type AgentScopeLayer = "input" | "role" | "output";
export type AgentScopeWhere = "chat" | "mcp_chat" | "generate" | "mcp_generate" | "items" | "save_draft" | "publish" | "chat_publish" | "tool";
export type AgentScopeLogEntry = {
  at: string;
  email: string;
  brandId: string;
  agent: AgentId;
  layer: AgentScopeLayer;
  where: AgentScopeWhere;
  verdict: Verdict | "error" | "wrong_agent";
  error?: string;
  mode: "shadow" | "enforce";
  text: string;
  itemId?: string;
};

/** How long a day's log is kept: 31 days from its first entry. */
const LOG_TTL_S = 31 * 86400;
/** The owner's words and an error message are cut to this many characters before they are stored. */
const LOG_CUT = 200;

/**
 * One line in today's (UTC) log, for the founder's panel. The text is cut to 200 characters. The list keeps the newest
 * `CAPS.agentScopeLog` lines and the day's key expires 31 days after its first line (EXPIRE NX, so a later line does not
 * move it). Never throws: a log that cannot be written must not stop the owner's turn. Only the error's name is printed.
 */
export async function logAgentScope(e: Omit<AgentScopeLogEntry, "at">): Promise<void> {
  try {
    const now = new Date();
    const k = AGENT_SCOPE_KEYS.log(now.toISOString().slice(0, 10));
    const row: AgentScopeLogEntry = { ...e, at: now.toISOString(), text: e.text.slice(0, LOG_CUT), ...(e.error === undefined ? {} : { error: e.error.slice(0, LOG_CUT) }) };
    await pushCapped(k, JSON.stringify(row), CAPS.agentScopeLog);
    await db.expireNx(k, LOG_TTL_S);
  } catch (err) {
    console.error("agent scope log failed", err instanceof Error ? err.name : "error");
  }
}

/** The text a check reads for an item: its title, a blank line, and the body the owner would publish (the edit, when there is one). */
export const itemText = (t: { title: string; body: string; editedBody?: string }): string => `${t.title}\n\n${t.editedBody ?? t.body}`;
/** sha256 (hex) of `itemText(t)`: ties a check to the exact text that was checked, so a later edit is a different hash. */
export const itemHash = (t: { title: string; body: string; editedBody?: string }): string => createHash("sha256").update(itemText(t)).digest("hex");

/**
 * The names of the account's brands other than the active one, for the classifier and the refusal copy. The default
 * brand's `BrandMeta.name` is "" (its name lives in the brand file), so it is read from `getBrand(user.email)`. Empty
 * names are dropped. One `Promise.all`: the list and the default brand's file.
 */
export async function otherBrandNames(user: User): Promise<string[]> {
  const active = user.brandId ?? "default";
  const [rows, main] = await Promise.all([listBrands(user.email), getBrand(user.email)]);
  return rows
    .filter((b) => b.id !== active)
    .map((b) => (b.id === "default" ? main?.name || b.name : b.name).trim())
    .filter((n) => n !== "");
}

/**
 * Thrown inside a generation batch when an enforced check refused it, so the existing catch refunds the whole batch.
 * `reply` is the refusal text the owner reads.
 */
export class AgentScopeRefused extends Error {
  constructor(readonly verdict: Exclude<Verdict, "in">, readonly reply: string) {
    super(`agent_scope_${verdict}`);
    this.name = "AgentScopeRefused";
  }
}

/** What a gate knows about the turn it is checking. `deadline` is when the caller's request ends (epoch ms), for the classifier. */
export type ScopeCtx = {
  user: User;
  agent: AgentId;
  where: AgentScopeWhere;
  lang: Lang;
  brand: { name: string; industry: string };
  otherBrands: string[];
  itemId?: string;
  deadline?: number;
};
/** `block: true` carries the refusal the owner reads; `verdict: "error"` is a check that failed and was told to fail closed. */
export type ScopeDecision = { block: false } | { block: true; verdict: Exclude<Verdict, "in"> | "error"; reply: string };

/**
 * The decision every gate asks for (rule 791; spec section 6). `layer` is the text's kind: the owner's words (`input`) or
 * an agent's text (`output`: a chat reply, an item, a draft, an item about to be published).
 *
 * - `off`: nothing happens, no call and no log.
 * - The classifier's `paused` error (the model is paused or mocked): the check counts as passed, no log.
 * - Any other error (`timeout`, `api`, `unknown_verdict`): logged as `verdict: "error"`. It blocks only with
 *   `o.failClosed` in `enforce` (a publish), with `agentScopeRetryText`; everywhere else the text goes through.
 * - Verdict `in`: passes, not logged.
 * - Any other verdict: logged with the mode. `enforce` blocks with `agentScopeRefusalText`, whose names come from the owner's
 *   own brands and not from the classifier's text; `shadow` lets it through.
 *
 * Never throws: a classifier that did throw is an `api` error, and the log and the count never throw. The classifier is
 * called with the turn's `deadline`. An `input` check that blocks in `enforce` on a verdict is counted toward the refusal
 * ceiling of `ctx.user`'s brand scope (`countAgentScopeRefusal`, rule 795). Nothing else counts: not shadow, not `in`, not
 * an error that failed closed, and not an `output` check (an agent's text is not a message the owner got for free).
 */
export async function scopeCheck(layer: "input" | "output", mode: AgentScopeMode, text: string, ctx: ScopeCtx, o: { failClosed?: boolean } = {}): Promise<ScopeDecision> {
  if (mode === "off") return { block: false };
  let verdict: Classified;
  try {
    verdict = await classify({ kind: layer, text, agent: ctx.agent, brand: ctx.brand, otherBrands: ctx.otherBrands, lang: ctx.lang }, { deadline: ctx.deadline });
  } catch {
    verdict = { ok: false, error: "api" };
  }
  const line = { email: ctx.user.email, brandId: ctx.user.brandId ?? "default", agent: ctx.agent, layer, where: ctx.where, mode, text, ...(ctx.itemId === undefined ? {} : { itemId: ctx.itemId }) };
  if (!verdict.ok) {
    if (verdict.error === "paused") return { block: false };
    await logAgentScope({ ...line, verdict: "error", error: verdict.error });
    return o.failClosed && mode === "enforce" ? { block: true, verdict: "error", reply: agentScopeRetryText(ctx.lang) } : { block: false };
  }
  if (verdict.verdict === "in") return { block: false };
  await logAgentScope({ ...line, verdict: verdict.verdict });
  if (mode !== "enforce") return { block: false };
  if (layer === "input") await countAgentScopeRefusal(ctx.user).catch((e) => console.error("agent scope refusal count failed", e instanceof Error ? e.name : "error"));
  return { block: true, verdict: verdict.verdict, reply: agentScopeRefusalText(verdict.verdict, ctx.lang, { brand: ctx.brand.name, otherBrands: ctx.otherBrands, classified: verdict.brand }) };
}
