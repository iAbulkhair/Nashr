import { agentById, type AgentId } from "./agents";
import { costUsd, usageWho } from "./usage";
import { metered } from "./metered";
import { CHAT_MAX_CALLS, estTokens, fitFirstCall, inputEstimateUsd, nextMaxTokens, trimHistory, workspaceLarge, type InputEst } from "./chat-budget";
import { MODEL_BUDGET, PAUSED_REPLY, anthropic, modelState, until } from "./model";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { sc, trialOver, type User } from "./auth";
import { acct } from "./account-id";
import { getBrand, listPreferencesFor, type Task } from "./brand";
import { feedbackFor } from "./feedback";
import { listFileNames, memoryBlock } from "./files";
import { deadlineFor } from "./media/keys";
import { listConnections } from "./connectors/store";
import { connectedTargets } from "./connectors/publish";
import type { BrandProposal } from "./brand-proposals";
import { byOf } from "./actor";
import { SEC_KEYS, calendarOf } from "./secretary";
import { handoffBlock, handoffNotesFor } from "./secretary-handoff";
import type { AwayProposal } from "./secretary-away";
import type { InstructionProposal } from "./instruction-proposals";
import { zoneOf } from "./zones";
import { loadLayers } from "./agent-instructions";
import { entitlements } from "./entitlements";
import { route } from "./models/route";
import { MODEL_UNAVAILABLE } from "./models/overrides";
import type { SpendProposal } from "./spend-proposals";
import type { FileProposal } from "./file-proposals";
import { otherBrandNames, readAgentScopeModes, scopeCheck, type ScopeCtx } from "./agent-scope";
import { log } from "./log";
import { CAPPED_REPLY, CHAT_MAX_DURATION_S, CUT_NOTE, type ChatOpts, type ChatTurn, DONE_REPLY, LARGE_REPLY, OUT_OF_TIME_REPLY, REFUSED_REPLY, chatRefusedText, textOf, turnParts, withLimit } from "./chat-reply";
import { type ChatMsg, deliver, history, push } from "./chat-history";
import { statusFor, system } from "./chat-prompt";
import { toolsFor } from "./chat-tools";
import { getGov } from "./governance";
import { policyNote } from "./tool-authority";
import { withRun } from "./runs";
import { gatedTool } from "./gateway";
import type { ToolCtx } from "./chat-gates";
import { runTool } from "./chat-run-tool";
import type { MemoryProposal } from "./memory";
import { REMEMBER_TOOL, runRemember } from "./memory-tool";
import { recall, recallBlock } from "./recall";
import { COMPACTION, MEMORY_V2 } from "./v2-flags";
import { compactThread, droppedTurns, proposeSummaryFacts, readSummary, summaryBlock, type ThreadSummary } from "./compaction";

export { history, push } from "./chat-history";
export type { ChatItem, ChatMsg, PlanItem } from "./chat-history";
export { EDITABLE_BRAND_FIELDS, CHAT_TOOL_NAMES, PROPOSE_HANDOFF_TOOL, CONTACT_AWAY_TOOL, PROPOSE_MEETING_TASKS_TOOL, FREE_SLOTS_TOOL, toolsFor } from "./chat-tools";
export type { EditableBrandField } from "./chat-tools";
export { system, statusFor } from "./chat-prompt";
export { CHAT_MAX_DURATION_S, CHAT_RENDER_MIN_MS, chatRefusedText, OUT_OF_TIME_REPLY, turnParts, CHAT_MODEL } from "./chat-reply";
export type { ChatOpts, ChatLimit, ChatRefused, ChatTurn } from "./chat-reply";
export { TOOL_ACTION, INSTRUCTION_CARDS_PER_REPLY } from "./chat-gates";
export type { ToolCtx } from "./chat-gates";
export { runTool } from "./chat-run-tool";

export async function chat(user: User, text: string, conv?: string, agentId: AgentId = "noor", opts: ChatOpts = {}): Promise<ChatTurn> {
  // One run of the run log (rules 4510-4519, src/lib/runs.ts): off in this release, a plain call then.
  return withRun({ scope: sc(user), kind: "chat", agent: agentId, via: opts.via ?? "app" }, () => chatTurn(user, text, conv, agentId, opts));
}

async function chatTurn(user: User, text: string, conv: string | undefined, agentId: AgentId, opts: ChatOpts): Promise<ChatTurn> {
  // Taken first: up to five model turns can use most of the ceiling before a tool starts a render.
  const deadline = opts.deadline ?? deadlineFor(CHAT_MAX_DURATION_S);
  const lang = opts.lang ?? user.lang;
  // The turn's one model: the first-call fit, every later cap and every stream below use this value.
  const model = opts.model ?? route("chat").model;
  const notice = opts.modelRejected ? `${MODEL_UNAVAILABLE.chat[lang]}\n\n` : "";
  // The backstop of the routes' own check (rule 330): an ended trial gets no model turn from any caller, and nothing is
  // written, not even the owner's message.
  if (trialOver(user)) return { role: "assistant", content: chatRefusedText("trial", lang), at: new Date().toISOString(), agent: agentId, limit: "trial" };
  const agentName = agentById(agentId).name[lang];
  opts.onStatus?.(lang === "ar" ? "أقرأ ملف علامتك ومذكراتي…" : "Reading your brand file and my notes…");
  const email = user.scope ?? acct(user);
  await push(email, { role: "user", content: text, at: new Date().toISOString() }, conv);
  const actions: string[] = [];
  const made: Task[] = [];
  const proposed: BrandProposal[] = [];
  const awayProposed: AwayProposal[] = [];
  const instructionProposed: InstructionProposal[] = [];
  const memoryProposed: MemoryProposal[] = [];
  const spendProposed: SpendProposal[] = [];
  const fileProposed: FileProposal[] = [];
  const via = opts.via ?? "app";

  const state = modelState();
  if (state !== "on") {
    // Paused: no tool runs, so nothing is charged or written; the owner is told plainly, in their language.
    const content = state === "paused" ? PAUSED_REPLY[lang] : "[DEV MOCK] No model key for the configured provider (ANTHROPIC_API_KEY; with LLM_PROVIDER=straitly, STRAITLY_API_KEY or ANTHROPIC_API_KEY). I would answer here and use tools.";
    const m: ChatMsg = { role: "assistant", content, at: new Date().toISOString(), actions, ...(state === "paused" ? { agent: agentId } : {}) };
    await push(email, m, conv);
    return m;
  }

  const client = anthropic({ timeoutMs: MODEL_BUDGET.CHAT_MS, maxRetries: 1 });
  // Independent reads, fetched together: one after another they cost 1-2 s of silence before every model call. The last
  // two are for the agent-scope input gate below: the modes (the route's copy when it passed one) and the names of the
  // account's other brands. A store error on the brand names must not cost the owner the turn: the gate reads none.
  const [brand, prefs, memory, files, conns, thread, feedback, notes, by, workDays, layers, scopeModes, otherBrands, gov, recalled, storedSummary] = await Promise.all([getBrand(email), listPreferencesFor(email, agentId), memoryBlock(email), listFileNames(email), listConnections(email), history(email, conv), feedbackFor(email, agentId, { chat: true }), handoffNotesFor(email, agentId), opts.by ?? byOf(user), db.get<unknown>(SEC_KEYS.cal(email)), loadLayers(sc(user), entitlements(user).instructions, "active", [agentId], "stub"), opts.agentScope ?? readAgentScopeModes(), otherBrandNames(user).catch((e): string[] => {
    log.error("agent scope brand names failed", e);
    return [];
  }), getGov(email), MEMORY_V2 ? recall(sc(user), text, { agent: agentId, conv }).catch((e): never[] => {
    log.error("recall failed", e);
    return [];
  }) : [], COMPACTION ? readSummary(sc(user), conv).catch((e): null => {
    log.error("thread summary read failed", e);
    return null;
  }) : (null as ThreadSummary | null)]);
  // The agent-scope input gate (rule 794; spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md 4.2),
  // after the paused return and the brand reads and before the first model call. The owner's message is already saved
  // above, so an enforced refusal saves only its reply: the thread reads the same as "message, then refusal".
  // - enforce: checked before the call. A refusal is the whole turn: no main model call, the reply delivered the way the
  //   paused reply is, and no `usd`, so the route's settle gives the message back (the classifier's cost is Thakeen's, on
  //   the global meter only). `scopeCheck` counts it toward the brand scope's refusal ceiling. An error fails open.
  // - shadow: started now, beside the turn, so it adds no wait before the first call, and awaited in the `finally` below on
  //   every way out (a return, a stream error, a throw from the meter, a tool or the save), so its log line is written before
  //   the request ends. The reply's shadow check (rule 800) joins the same list.
  const scopeCtx: ScopeCtx = { user, agent: agentId, where: via === "mcp" ? "mcp_chat" : "chat", lang, brand: { name: brand?.name ?? "", industry: brand?.industry ?? "" }, otherBrands, deadline };
  if (scopeModes.input === "enforce") {
    const d = await scopeCheck("input", "enforce", text, scopeCtx);
    if (d.block) {
      const m: ChatTurn = { role: "assistant", content: d.reply, at: new Date().toISOString(), agent: agentId };
      await push(email, m, conv);
      return m;
    }
  }
  const late: Promise<unknown>[] = scopeModes.input === "shadow" ? [scopeCheck("input", "shadow", text, scopeCtx)] : [];
  try {
    const connected = connectedTargets(conns);
    // The brand's own weekend (its Working days settings, else its country's): the NOW line names the week start from it.
    const weekend = calendarOf(workDays, zoneOf(brand), Date.now()).weekend;
    const sys = system(brand, user, prefs, memory, files, connected, agentId, feedback, handoffBlock(notes), weekend, layers, { prompt: scopeModes.prompt === "on", roleEnforced: scopeModes.role === "enforce" });
    // The owner's tool authority, in the workspace block (the brand file's block): one line naming what is off or ask-first.
    const authority = policyNote(gov.toolPolicy, agentId);
    if (authority) sys[1] = { ...sys[1], text: sys[1].text + authority };
    // Scoped memory (v2 phase 1, rule 4562): the facts recalled for this message, in the uncached block, fenced as data.
    const remembered = recallBlock(recalled);
    if (remembered) sys[2] = { ...sys[2], text: sys[2].text + remembered };
    // The owner's tool authority (rule 2431): a capability switched off for this agent is not offered in this turn.
    const tools = toolsFor(agentId, gov.toolPolicy);
    // The per-message ceiling (CHAT_TURN_MAX_USD), checked in code before every call (src/lib/chat-budget.ts). The first
    // call: the thread, already cut by the history guard, is shortened from its oldest end until the call has room for a
    // full answer. Every later call: estimated from the previous call's metered input (its cached prefix as a cache read)
    // and output, plus the tool results added since.
    const trimmed = trimHistory(thread);
    // Thread compaction (v2 phase 1, C11, rules 4580-4589): the messages the guard dropped are folded into the thread's
    // summary, read as data in the uncached block before the first call is fitted. Off, nothing is read or written.
    if (COMPACTION) {
      const c = await compactThread(sc(user), conv, storedSummary, droppedTurns(thread, trimmed.length), { agent: agentId, deadline, lang, onStatus: opts.onStatus });
      const block = summaryBlock(c.summary);
      if (block) sys[2] = { ...sys[2], text: sys[2].text + block };
      if (MEMORY_V2) await proposeSummaryFacts(sc(user), c.facts, { agent: agentId, conv, via }, by, memoryProposed);
    }
    const fit = fitFirstCall(model, trimmed, JSON.stringify(tools).length + sys[0].text.length + sys[1].text.length, sys[2].text.length);
    const large = workspaceLarge(trimmed.length, fit);
    const messages: Anthropic.MessageParam[] = fit.messages;
    if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: text });
    let spent = 0;
    let next: InputEst = { cached: 0, fresh: 0 };
    let ended: "capped" | "cut" | "large" | "refused" | null = null;
    let cutText = "";

    // Two ceilings end the loop before a call. The per-message cost (CHAT_TURN_MAX_USD, above): no room left for a useful
    // answer. The turn's overall deadline (rule 336): a call starts only with CHAT_TURN_MIN_MS left, and its stream ends
    // CHAT_REPLY_MS before the deadline, so the reply is saved and answered before the platform's kill, and a tool that
    // charged inside the turn (generate_content, draft_items) has its own refund within the same deadline.
    let outOfTime = false;
    for (let turn = 0; turn < CHAT_MAX_CALLS; turn++) {
      const maxTokens = turn === 0 ? fit.maxTokens : nextMaxTokens(model, spent, inputEstimateUsd(model, next, false));
      if (!maxTokens) {
        ended = turn === 0 ? "large" : "capped";
        break;
      }
      if (deadline - Date.now() < MODEL_BUDGET.CHAT_TURN_MIN_MS) { outOfTime = true; break; }
      const call = until(deadline - MODEL_BUDGET.CHAT_REPLY_MS, { cap: MODEL_BUDGET.CHAT_MS });
      let res: Anthropic.Message;
      try {
        // Metered inside `metered`, an aborted stream included: the API bills what it read and wrote before the deadline.
        res = await metered(client.messages.stream({ model, max_tokens: maxTokens, system: sys, messages, tools, thinking: { type: "adaptive" }, output_config: { effort: "medium" } }, call), { email: acct(user), kind: "chat", agent: agentId, requested: model, who: usageWho(user, sc(user)) });
      } catch (e) {
        if (call.signal.aborted) { outOfTime = true; break; }
        throw e;
      }
      spent += costUsd(res.model, res.usage);
      if (res.stop_reason === "refusal") {
        // The model's safety check declined the turn (Sonnet 5.5 has broader classifiers than Opus 5, false positives
        // included). Billed and metered like any call; the owner is told plainly instead of "Done".
        ended = "refused";
        break;
      }
      if (res.stop_reason === "max_tokens") {
        // Cut off at its cap: a tool call in it may be incomplete, so none of them runs. The text so far is kept, marked.
        ended = "cut";
        cutText = textOf(res.content);
        break;
      }
      messages.push({ role: "assistant", content: res.content });
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        // The final answer gets the output check (rule 800), and so does a reply cut at its cap (below): the fixed replies
        // below and the paused reply are Thakeen's own words. `enforce` is awaited before the save and a refusal replaces the text; the cards stay and `usd`
        // stays, because the main model was called. `shadow` starts beside the save and is awaited in the `finally`. An error,
        // and an empty answer (nothing to read), let the text through.
        const said = textOf(res.content);
        let shown = said;
        if (said && scopeModes.output !== "off") {
          const check = scopeCheck("output", scopeModes.output, said, scopeCtx);
          if (scopeModes.output === "enforce") {
            const out = await check;
            shown = out.block ? out.reply : said;
          } else late.push(check);
        }
        const m: ChatTurn = { role: "assistant", content: notice + (shown || "…"), at: new Date().toISOString(), ...turnParts(actions, made, proposed, awayProposed, instructionProposed, spendProposed, fileProposed, memoryProposed), agent: agentId };
        await deliver(email, m, conv);
        return withLimit(m, actions, spent);
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        let out = "";
        let isError = false;
        opts.onStatus?.(statusFor(u.name, lang, agentName));
        try {
          // Through the action gateway (rules 4500-4509, src/lib/gateway.ts): off in this release; in log mode it records the
          // call and its verdict and never changes the answer. Every gate in runTool still decides.
          const ctx: ToolCtx = { lang, agent: agentId, by, via, proposed, awayProposed, instructionProposed, memoryProposed, spendProposed, fileProposed, ownerMsg: text, conv, modes: scopeModes };
          out = await gatedTool(user, u.name, ctx, () => (u.name === REMEMBER_TOOL.name ? runRemember(user, u.input as Record<string, unknown>, ctx) : runTool(user, u.name, u.input as Record<string, unknown>, actions, made, deadline, ctx)));
        } catch (e) {
          isError = true;
          out = e instanceof Error ? e.message : "tool_failed";
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content: out, is_error: isError });
      }
      messages.push({ role: "user", content: results });
      next = { cached: (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), fresh: (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0) + estTokens(JSON.stringify(results).length) };
    }
    // The loop ended without a closing answer: the request ran out of time, the calls ran out, the model refused, a call was
    // cut off at its cap, or the ceiling left no room for another call. What the tools made is on the reply's cards and in
    // the inbox either way, and a limit a tool hit still raises its dialog.
    // A reply cut at its cap is the model's own text, so it gets the same output check as a final answer (rule 800, spec 4.4):
    // `enforce` shows the refusal in its place, without the cut note (there is nothing to continue); `shadow` keeps it and the
    // check joins `late`. Every other reply here is Thakeen's fixed text and is not checked.
    let cut = cutText ? `${cutText}\n\n${CUT_NOTE[lang]}` : CAPPED_REPLY[lang];
    if (!outOfTime && ended === "cut" && cutText && scopeModes.output !== "off") {
      const check = scopeCheck("output", scopeModes.output, cutText, scopeCtx);
      if (scopeModes.output === "enforce") {
        const out = await check;
        if (out.block) cut = out.reply;
      } else late.push(check);
    }
    const content = outOfTime ? OUT_OF_TIME_REPLY[lang] : ended === "refused" ? REFUSED_REPLY[lang] : ended === "large" ? LARGE_REPLY[lang] : ended === "cut" ? cut : ended === "capped" ? CAPPED_REPLY[lang] : DONE_REPLY[lang];
    const m: ChatTurn = { role: "assistant", content: notice + content, at: new Date().toISOString(), ...turnParts(actions, made, proposed, awayProposed, instructionProposed, spendProposed, fileProposed, memoryProposed), ...(spent > 0 || outOfTime ? { agent: agentId } : {}), ...(large && ended !== "large" && !outOfTime ? { large: true as const } : {}) };
    await deliver(email, m, conv);
    return withLimit(m, actions, spent);
  } finally {
    await Promise.allSettled(late);
  }
}
