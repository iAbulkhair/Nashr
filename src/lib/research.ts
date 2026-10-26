import type Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "crypto";
import type { By } from "./actor";
import { AGENT_IDS, isAgentId, type AgentId } from "./agents";
import { crawl } from "./crawl";
import { db } from "./db";
import { providerTimeout } from "./fetch-timeout";
import { wsKey, type Scope } from "./keys";
import { log } from "./log";
import { responseJson } from "./read-capped";

/**
 * The research tool's store and its two outside calls (Thakeen v2 phase 4, C10, rules 4790-4819). The chat tools are in
 * src/lib/research-tool.ts; the card's route is POST /api/chat/research/[id].
 *
 * The model never runs a search on its own say-so. `web_search` stores a proposal (the query, the agent, the thread and
 * the price) and the card under the reply shows it; a person with `generate` presses Approve (`decideResearch`), which
 * puts the id on the thread for that agent's next turn, and that turn runs the stored query, never one from the model's
 * new input. `read_page` opens only addresses an approved search returned in the same thread, or one the person wrote in
 * the turn's own message: a page cannot send the agent to a page of its choosing, which would carry data out in a URL.
 *
 * Everything that comes back is outside text: it is cut, stripped of markup and fenced (`fenced`) before the model sees
 * it, and the tool's answer says it is data and must be cited. Keys are all under the caller's scope (`sc(u)`).
 */

/**
 * The agents whose work needs outside facts (the plan's C10): growth, marketing, product. Code gate, in `toolsFor` and
 * the tool. Keyed by every agent, so a ninth agent is a type error here until someone decides (rule 202: lists come from
 * the registry).
 */
const RESEARCHES: Record<AgentId, boolean> = {
  noor: true,
  sami: false,
  razan: false,
  faris: true,
  dana: false,
  majed: false,
  layan: true,
  reem: false,
};
export const RESEARCH_AGENTS: readonly AgentId[] = AGENT_IDS.filter((a) => RESEARCHES[a]);
export const isResearchAgent = (a: AgentId | undefined): a is AgentId => !!a && RESEARCH_AGENTS.includes(a);

/**
 * Credits one approved search costs the account. A placeholder: the price, and turning research on for customers, are
 * the founder's (plan decision 2026-10-25), and `RESEARCH` stays off until then. Reading a page costs no credits.
 */
export const SEARCH_CREDITS = 1;
/** What one search costs us at the provider, in dollars, for the account's meter (`meterSearch`). An estimate from the list price. */
export const SEARCH_USD = 0.005;
export const RESULTS_PER_SEARCH = 5;
export const SEARCHES_PER_REPLY = 1;
export const PAGES_PER_REPLY = 3;
export const QUERY_MAX = 200;
export const PAGE_CHARS = 6000;
const SNIPPET_CHARS = 300;
const TITLE_CHARS = 160;
const URL_CHARS = 2000;
const PROP_TTL_S = 86400;
const OK_TTL_S = 3600;
const URLS_TTL_S = 3600;
const ID = /^[a-f0-9]{16}$/;
export const isResearchId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

export type ResearchState = "open" | "approved" | "ran" | "dismissed";
export type ResearchProposal = {
  id: string;
  agent: AgentId;
  conv: string;
  query: string;
  lang: "ar" | "en";
  credits: number;
  at: string;
  by: By;
  state: ResearchState;
  decidedAt?: string;
};
/** What the card reads: no `by`, no thread. */
export type ResearchCard = Pick<ResearchProposal, "id" | "agent" | "query" | "credits" | "state" | "at">;
export const researchCard = (p: ResearchProposal): ResearchCard => ({
  id: p.id,
  agent: p.agent,
  query: p.query,
  credits: p.credits,
  state: p.state,
  at: p.at,
});

/** The chat's thread id for keys: the default thread has no record, so it is "default", like the conversation list. */
export const convOf = (conv: string | undefined) => (conv && /^[A-Za-z0-9_-]{1,64}$/.test(conv) ? conv : "default");

/** A query from the model: one line, trimmed, 2 to `QUERY_MAX` characters, or null. */
export function cleanQuery(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const q = v
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q.length >= 2 && q.length <= QUERY_MAX ? q : null;
}

export async function proposeResearch(
  s: Scope,
  input: Omit<ResearchProposal, "id" | "at" | "state">,
): Promise<ResearchProposal> {
  const p: ResearchProposal = {
    ...input,
    id: randomBytes(8).toString("hex"),
    at: new Date().toISOString(),
    state: "open",
  };
  // The id first: a proposal saved is always one `wipeAccount` can find.
  await db.sadd(wsKey.researchProps(s), p.id);
  await Promise.all([
    db.expire(wsKey.researchProps(s), PROP_TTL_S),
    db.set(wsKey.researchProp(s, p.id), p, PROP_TTL_S),
  ]);
  return p;
}

export async function getResearch(s: Scope, id: string): Promise<ResearchProposal | null> {
  if (!isResearchId(id)) return null;
  const p = await db.get<ResearchProposal>(wsKey.researchProp(s, id));
  return p && isAgentId(p.agent) ? p : null;
}

export type ResearchDecision = { ok: true; p: ResearchProposal } | { ok: false; error: "not_found" | "decided" };

/**
 * A person's answer on the card (rule 4794). Approve puts the id on the thread for that agent's next turn; the search
 * itself runs in that turn (`takeApproved`), so the charge, the meter and the run log stay in one place. A second press,
 * or an answer to a card already decided, changes nothing.
 */
export async function decideResearch(s: Scope, id: string, action: "approve" | "dismiss"): Promise<ResearchDecision> {
  const p = await getResearch(s, id);
  if (!p) return { ok: false, error: "not_found" };
  if (p.state !== "open") return { ok: false, error: "decided" };
  const next: ResearchProposal = {
    ...p,
    state: action === "approve" ? "approved" : "dismissed",
    decidedAt: new Date().toISOString(),
  };
  await Promise.all([
    db.set(wsKey.researchProp(s, id), next, PROP_TTL_S),
    action === "approve" ? db.set(wsKey.researchOk(s, p.conv, p.agent), id, OK_TTL_S) : Promise.resolve(null),
  ]);
  return { ok: true, p: next };
}

/**
 * The approved search waiting for this agent in this thread, taken once (GETDEL: two turns at once cannot both run it)
 * and marked ran. Null when none waits, or when it is no longer approved.
 */
export async function takeApproved(s: Scope, conv: string, agent: AgentId): Promise<ResearchProposal | null> {
  const id = await db.getdel<string>(wsKey.researchOk(s, conv, agent));
  const p = typeof id === "string" ? await getResearch(s, id) : null;
  if (!p || p.state !== "approved" || p.agent !== agent || p.conv !== conv) return null;
  const ran: ResearchProposal = { ...p, state: "ran" };
  await db.set(wsKey.researchProp(s, p.id), ran, PROP_TTL_S);
  return ran;
}

/** Every key the research store of one scope can leave, for `wipeAccount`: proposals, their approvals and page lists, the index. */
export async function researchKeys(s: Scope): Promise<string[]> {
  const ids = (await db.smembers(wsKey.researchProps(s))).filter(isResearchId);
  const rows = ids.length ? await db.mget<ResearchProposal>(ids.map((id) => wsKey.researchProp(s, id))) : [];
  const extra = rows.flatMap((p) =>
    p && isAgentId(p.agent) ? [wsKey.researchOk(s, p.conv, p.agent), wsKey.researchUrls(s, p.conv)] : [],
  );
  return [...ids.map((id) => wsKey.researchProp(s, id)), ...new Set(extra), wsKey.researchProps(s)];
}

/** Markup, entities and control characters out; one line; cut. Outside text, so nothing of its shape survives. */
export function plain(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** An address from outside: http(s) only, no credentials, cut at `URL_CHARS`; null otherwise. */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > URL_CHARS) return null;
  try {
    const u = new URL(v.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; error: "not_configured" | "failed" };

/** The provider's address. Fixed in code, never from a request or the model, so this is not a user-supplied URL. */
const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

/**
 * One web search at the provider (Brave Search, `BRAVE_SEARCH_API_KEY`, docs/system/variables.md). The key never appears
 * in a log or an answer. Results are cut and stripped here; the caller fences them.
 */
export async function searchWeb(query: string, lang: "ar" | "en"): Promise<SearchOutcome> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return { ok: false, error: "not_configured" };
  const q = new URLSearchParams({
    q: query,
    count: String(RESULTS_PER_SEARCH),
    search_lang: lang,
    country: "SA",
    safesearch: "moderate",
  });
  try {
    const res = await fetch(`${SEARCH_URL}?${q}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: providerTimeout(),
    });
    if (!res.ok) {
      log.warn("research.search_failed", { status: res.status });
      return { ok: false, error: "failed" };
    }
    const j = await responseJson<{ web?: { results?: unknown[] } }>(res, 512 * 1024);
    const results = (Array.isArray(j.web?.results) ? j.web.results : []).flatMap((r): SearchResult[] => {
      const o = (r ?? {}) as Record<string, unknown>;
      const url = cleanUrl(o.url);
      return url ? [{ title: plain(o.title, TITLE_CHARS), url, snippet: plain(o.description, SNIPPET_CHARS) }] : [];
    });
    return { ok: true, results: results.slice(0, RESULTS_PER_SEARCH) };
  } catch (e) {
    log.warn("research.search_failed", { error: e instanceof Error ? e.name : "unknown" });
    return { ok: false, error: "failed" };
  }
}

/** Remember the addresses an approved search returned, so `read_page` may open them in this thread for an hour. */
export async function keepUrls(s: Scope, conv: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const k = wsKey.researchUrls(s, conv);
  await Promise.all(urls.map((u) => db.sadd(k, u)));
  await db.expire(k, URLS_TTL_S);
}

export async function urlAllowed(s: Scope, conv: string, url: string): Promise<boolean> {
  return !!(await db.sismember(wsKey.researchUrls(s, conv), url));
}

/** The addresses written in the person's own message: the other way a page may be read. */
export function urlsIn(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/https?:\/\/[^\s<>"'«»]+/g)].flatMap((m) => {
    const u = cleanUrl(m[0].replace(/[).,،؛!?]+$/, ""));
    return u ? [u] : [];
  });
}

export type PageOutcome = { ok: true; title: string; text: string } | { ok: false };
/** One page through `crawl` (safeFetch, a 9 s deadline, the first 2 MB), as plain text cut at `PAGE_CHARS`. */
export async function readPage(url: string): Promise<PageOutcome> {
  const snap = await crawl(url);
  if (!snap.ok) return { ok: false };
  return {
    ok: true,
    title: plain(snap.title, TITLE_CHARS),
    text: snap.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").slice(0, PAGE_CHARS),
  };
}

/**
 * Outside text as the model sees it: inside one `<web_data>` block that its own text cannot close or reopen (every
 * `<` and `>` in it is replaced), with the address it came from. The tool's answer around it says it is data.
 */
export function fenced(source: string, body: string): string {
  const safe = (x: string) => x.replace(/</g, "‹").replace(/>/g, "›");
  return `<web_data source="${safe(source).replace(/"/g, "'")}">\n${safe(body)}\n</web_data>`;
}

/** "1 credit", "2 credits": local, so this module imports nothing from the chat (chat-tools.ts imports it). */
export const creditWord = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

/**
 * The tool definitions (rules 4795-4797), here and not in research-tool.ts so `toolsFor` (src/lib/chat-tools.ts) reads them
 * without an import cycle through the chat gates.
 */
export const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  description: `Search the web when the work needs an outside fact the brand file, the owner and the workspace files do not have (a competitor's offer, a market trend, a regulation). Each search waits for a person's Approve on a card under your reply and costs ${creditWord(SEARCH_CREDITS)} when it runs; after the approval, call it again in the next turn and the approved query runs. One search a reply.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        maxLength: QUERY_MAX,
        description: "A short search query, in the language the results should be in.",
      },
    },
  },
};
export const READ_PAGE_TOOL: Anthropic.Tool = {
  name: "read_page",
  description: `Read one web page as text: only an address an approved web_search returned in this thread, or a link the person wrote in their message. Free; ${PAGES_PER_REPLY} pages a reply.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string" } },
  },
};
export const RESEARCH_TOOLS: readonly Anthropic.Tool[] = [WEB_SEARCH_TOOL, READ_PAGE_TOOL];
export const isResearchTool = (name: string) => name === WEB_SEARCH_TOOL.name || name === READ_PAGE_TOOL.name;
