/**
 * The chat: limits, options, the reply texts for a refused or capped turn, and the shape of a finished turn (`turnParts`, `ChatTurn`).
 */
import { isAgentId } from "./agents";
import type Anthropic from "@anthropic-ai/sdk";
import type { Task } from "./brand";
import type { BrandProposal } from "./brand-proposals";
import type { By } from "./actor";
import { cleanLine } from "./secretary";
import type { AwayProposal } from "./secretary-away";
import { proposalCard, type InstructionProposal } from "./instruction-proposals";
import { MEMORY_CARDS_PER_REPLY, memoryCard, type MemoryProposal } from "./memory";
import { chatItemOf } from "./handoffs";
import { DEFAULTS, type Rejected } from "./models/route";
import { SPEND_CARDS_PER_REPLY, spendCard, type SpendProposal } from "./spend-proposals";
import { fileProposalCard, type FileProposal } from "./file-proposals";
import type { AgentScopeModes } from "./agent-scope";
import type { TeamTurn } from "./team-chat";
import type { ChatMsg } from "./chat-history";
import { AWAY_CARDS_PER_REPLY, BRAND_CARDS_PER_REPLY, FILE_CARDS_PER_REPLY, INSTRUCTION_CARDS_PER_REPLY } from "./chat-gates";
import { appHref } from "@/lib/ws-path";
import type { RunEvent } from "./runs";

/**
 * The `maxDuration` of the two routes that call chat(), `/api/chat` and `/api/mcp` (route config must be a literal, so
 * they cannot import this; tests/chat-deadline.test.ts keeps the three equal).
 */
export const CHAT_MAX_DURATION_S = 300;
/** A render started from chat needs the prompt, the submit and the copy inside the request: with less left, none starts. */
export const CHAT_RENDER_MIN_MS = 60_000;

/**
 * `deadline`: the request's one deadline (spec A23), `deadlineFor(maxDuration)` from the route's start. Without it, counted from chat()'s own start.
 * `by`: who is talking, for the activity log; the MCP route passes `tokenBy(user)`, and without it `byOf(user)` reads the session.
 * `via`: "mcp" when the turn came through ask_noor, so tools that publish or rewrite core memory are refused (runTool).
 * `model`: the turn's model, which the caller already resolved with `route("chat")` and reserved the allowance for
 * (`reserveChatTurn`, src/lib/chat-allowance.ts): every call of the turn runs on it, so the model called and the model
 * counted are one value. Left out, `chat()` asks `route("chat")` itself (a caller that reserves nothing).
 * `modelRejected`: the conversation's pick was not used (`chatRouteFor`, src/lib/models/overrides.ts): an answered reply
 * starts with `MODEL_UNAVAILABLE.chat` in the reply language, saved with it. A paused or mock reply made no model call
 * and carries no notice.
 * `agentScope`: the founder's agent-scope modes, which the route already read with the refusal ceiling
 * (`agentScopePreflight`, src/lib/agent-scope.ts), so they are read once per request. Left out, `chat()` reads them itself.
 */
export type ChatOpts = { onStatus?: (text: string) => void; lang?: "ar" | "en"; deadline?: number; by?: By; via?: "app" | "mcp"; model?: string; modelRejected?: Rejected; agentScope?: AgentScopeModes; /** the turn's place in a team thread (v2 C4 + C12), set by the chat route while TEAM_CHAT is on */ team?: TeamTurn; /** hears each step of the turn's run as it happens (v2 C9, rule 4774); only while RUN_LOG is on */ onStep?: (e: RunEvent) => void };
/** Why a tool could not spend: the app raises the matching limit dialog. `agent_cap` is the owner's monthly cap for one agent. */
export type ChatLimit = "credits" | "trial" | "agent_cap" | "fair_use";

/**
 * Why a chat turn was refused before any model call (rules 330-331): an ended trial, or the hourly or daily ceiling of
 * `chatRefusal` (src/lib/rate.ts). The text the owner reads, in their language, with the way forward. `origin` makes the
 * billing link absolute (MCP: the words are read outside the app); `cap` is the ceiling that refused.
 */
export type ChatRefused = "trial" | "hour" | "day";
export function chatRefusedText(kind: ChatRefused, lang: "ar" | "en", o: { origin?: string; cap?: number } = {}): string {
  const billing = `${o.origin ?? ""}${appHref(lang, "/billing")}`;
  const n = o.cap !== undefined ? ` (${o.cap})` : "";
  if (lang === "ar") {
    if (kind === "trial") return `انتهت تجربتك المجانية، فلن يرد الوكلاء على رسائل جديدة حتى يُفعَّل اشتراك. كل ما في صندوقك وملفاتك محفوظ. [اختر خطة من صفحة الاشتراك](${billing}) (أو اطلب ذلك من مالك الحساب) ليكمل الفريق من حيث توقف. لم يُخصم أي كريدت.`;
    return kind === "hour"
      ? `وصلت إلى حد الرسائل في الساعة${n}، فتوقفت المحادثة مؤقتاً. حاول بعد ساعة. لم يُخصم أي كريدت.`
      : `وصلت إلى حد الرسائل اليومي${n}، فتوقفت المحادثة حتى الغد. لم يُخصم أي كريدت.`;
  }
  if (kind === "trial") return `Your free trial has ended, so the agents won't answer new messages until a plan is active. Everything in your inbox and files is kept. [Choose a plan on the Subscription page](${billing}) (or ask the account owner to) and the team picks up where it stopped. No credits were used.`;
  return kind === "hour"
    ? `You've reached the hourly message limit${n}, so chat is paused for now. Try again in an hour. No credits were used.`
    : `You've reached the daily message limit${n}, so chat is paused until tomorrow. No credits were used.`;
}

/** The reply of a turn that ran out of its request's time (rule 336): what was made is saved, and the owner can go on. */
export const OUT_OF_TIME_REPLY = {
  ar: "انتهى الوقت المتاح لهذا الرد قبل أن أكمله. ما أنشأته محفوظ في صندوق الموافقة، واطلب مني المتابعة لأكمل.",
  en: "This reply ran out of time before I could finish it. Anything I created is saved in your inbox; ask me to continue and I'll pick it up.",
} as const;

/** A name from a tool call as the answer quotes it: one cleaned line, at most 80 characters. */
export const cleanName = (v: unknown) => (typeof v === "string" ? cleanLine(v).slice(0, 80) : "");
/** The text blocks of a model response, joined. */
export const textOf = (content: Anthropic.ContentBlock[]) => content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
/** What every reply of a turn carries: its actions (without the `limit:*` tags), the items made, the handoff card, the switch card, brand proposals, away proposals, instruction proposals and spend proposals (as cards: without who proposed). */
export function turnParts(actions: string[], made: Task[], proposed: BrandProposal[], awayProposed: AwayProposal[] = [], instructionProposed: InstructionProposal[] = [], spendProposed: SpendProposal[] = [], fileProposed: FileProposal[] = [], memoryProposed: MemoryProposal[] = []): Pick<ChatMsg, "actions" | "items" | "handoff" | "goalPlan" | "teamCard" | "research" | "switchTo" | "proposals" | "awayProposals" | "instructionProposals" | "spendProposals" | "fileProposals" | "memoryProposals"> {
  return { actions: actions.filter((a) => !a.startsWith("limit:")), ...(made.length ? { items: made.slice(0, 10).map(chatItemOf) } : {}), ...handoffOf(actions), ...goalPlanOf(actions), ...teamCardOf(actions), ...researchOf(actions), ...switchOf(actions), ...(proposed.length ? { proposals: proposed.slice(0, BRAND_CARDS_PER_REPLY) } : {}), ...(awayProposed.length ? { awayProposals: awayProposed.slice(0, AWAY_CARDS_PER_REPLY) } : {}), ...(instructionProposed.length ? { instructionProposals: instructionProposed.slice(0, INSTRUCTION_CARDS_PER_REPLY).map(proposalCard) } : {}), ...(spendProposed.length ? { spendProposals: spendProposed.slice(0, SPEND_CARDS_PER_REPLY).map(spendCard) } : {}), ...(fileProposed.length ? { fileProposals: fileProposed.slice(0, FILE_CARDS_PER_REPLY).map(fileProposalCard) } : {}), ...(memoryProposed.length ? { memoryProposals: memoryProposed.slice(0, MEMORY_CARDS_PER_REPLY).map(memoryCard) } : {}) };
}
/** After the reply is saved: the first limit a tool hit (the app raises its dialog) and the turn's model cost, neither saved. */
export function withLimit(m: ChatTurn, actions: string[], spent: number): ChatTurn {
  const lim = actions.find((a) => a.startsWith("limit:"));
  if (lim) m.limit = lim.slice(6) as ChatLimit;
  m.usd = spent;
  return m;
}

/**
 * The default chat model: Sonnet 5.5 since 2026-10-02 (founder decision; it was Opus 5), at the same effort and adaptive
 * thinking. Its rates are Opus 5's divided by 2.5, and so is the per-message ceiling (`CHAT_TURN_MAX_USD`). It is
 * `DEFAULTS.chat` (src/lib/models/route.ts), the model the chat credit multipliers are relative to; a turn runs on
 * `route("chat").model`, which is this unless the owner picked another. Generation, onboarding and the reviewer keep their
 * own models (src/lib/task-costs.ts `ESTIMATE_MODELS`).
 */
export const CHAT_MODEL = DEFAULTS.chat;
/** A turn's reply plus what only the route reads (never saved, never sent to the browser): the limit dialog to raise and what the turn's model calls cost in USD. */
export type ChatTurn = ChatMsg & { limit?: ChatLimit; usd?: number };
export const DONE_REPLY = { ar: "تم. تحقق من صندوق الموافقة.", en: "Done. Check your approvals inbox." } as const;
export const CAPPED_REPLY = {
  ar: "وصل هذا الرد إلى حدّه فتوقفت هنا. ما أنجزته ظاهر في البطاقات وفي صندوق الموافقة، واكتب «كمّل» إن أردت أن أتابع.",
  en: "This reply reached its limit, so I stopped here. What I did is on the cards and in your approvals inbox; say \"continue\" if you want me to carry on.",
} as const;
export const CUT_NOTE = { ar: "(انقطع الرد عند حدّه. اكتب «كمّل» لأتابع.)", en: "(The reply was cut off at its limit. Say \"continue\" and I will carry on.)" } as const;
/** The model declined the turn (`stop_reason: "refusal"`). Nothing the model wrote is shown; what tools made before is on the cards. */
export const REFUSED_REPLY = {
  ar: "لم أستطع إكمال هذا الطلب. جرّب صياغته بطريقة أخرى، وما أنجزته قبل ذلك ظاهر في البطاقات وفي صندوق الموافقة.",
  en: "I couldn't complete this request. Try wording it another way; anything I did before that is on the cards and in your approvals inbox.",
} as const;
/** No model call was made: even the owner's message alone, with this workspace, leaves no room inside the ceiling. Not counted. */
export const LARGE_REPLY = {
  ar: "لم أستطع الرد على هذه الرسالة: ملفات مساحة العمل كبيرة جداً على رسالة واحدة. اختصر ملفاتك الطويلة في صفحة الملفات أو ابدأ محادثة جديدة، ثم أعد المحاولة. لم تُحسب هذه الرسالة.",
  en: "I could not answer this message: your workspace files are too large for one message. Shorten your long files on the Files page or start a new conversation, then try again. This message was not counted.",
} as const;

/** The handoff a turn proposed (its `handoff:{id}` action), as the reply's card reference. One per turn at most. */
function handoffOf(actions: string[]): Pick<ChatMsg, "handoff"> {
  const id = actions.find((a) => a.startsWith("handoff:"))?.slice(8);
  return id ? { handoff: { id } } : {};
}

/** The plan `make_plan` saved this turn (`goalplan:{id}`, v2 C3): one card a reply. */
function goalPlanOf(actions: string[]): Pick<ChatMsg, "goalPlan"> {
  const id = actions.find((a) => a.startsWith("goalplan:"))?.slice(9);
  return id && /^[0-9a-f]{16}$/.test(id) ? { goalPlan: { id } } : {};
}

/** The research card `web_search` put on this turn (`research:{id}`, v2 C10, rule 4800): one a reply. */
function researchOf(actions: string[]): Pick<ChatMsg, "research"> {
  const id = actions.find((a) => a.startsWith("research:"))?.slice(9);
  return id && /^[0-9a-f]{16}$/.test(id) ? { research: { id } } : {};
}

/** The teammate card `propose_teammate` put on this turn (`team:ask:{id}` or `team:owner:{id}`, v2 C4 + C12): one a reply. */
function teamCardOf(actions: string[]): Pick<ChatMsg, "teamCard"> {
  const a = actions.find((x) => x.startsWith("team:"));
  const [, kind, id] = a?.split(":") ?? [];
  return (kind === "ask" || kind === "owner") && isAgentId(id) ? { teamCard: { agent: id, kind } } : {};
}

/**
 * The agent a role refusal sent the owner to (rule 798): the last `switch:{agent}` action of the turn whose id is a known agent.
 * An id that is not one is passed over (the action is built from the registry, so this is a second check on what the reply
 * carries to the client), and a turn with no such action carries no card.
 */
function switchOf(actions: string[]): Pick<ChatMsg, "switchTo"> {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (!actions[i].startsWith("switch:")) continue;
    const id = actions[i].slice(7);
    if (isAgentId(id)) return { switchTo: id };
  }
  return {};
}
