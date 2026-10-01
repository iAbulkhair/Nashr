import { NextResponse } from "next/server";
import { MCP_TOOL_ACTION, userFromBearer } from "@/lib/mcp";
import { CHAT_CAPS, DRAFTS_PER_HOUR, chatRefusal } from "@/lib/rate";
import { DRAFT_LIMITS, draftReport, parseDraft, saveExternalDraft } from "@/lib/external-drafts";
import { chat, chatRefusedText } from "@/lib/chat";
import { trialOver } from "@/lib/auth";
import { ORIGIN } from "@/lib/oauth";
import { refusalText, reserveChatTurn, runChatTurn } from "@/lib/chat-allowance";
import { getBrand, listTasks } from "@/lib/brand";
import { agentById } from "@/lib/agents";
import { TASK_COST, isTaskType } from "@/lib/tasks";
import { generateBatch } from "@/lib/generate-batch";
import { listFiles, readFile } from "@/lib/files";
import { CUSTOMER_FACING, brandRules, explain, gateTask, isCustomerFacing } from "@/lib/brand-rules";
import { tokenBy } from "@/lib/actor";
import { SEC_TOOL_DEFS, isSecTool, runSecretaryTool } from "@/lib/secretary";
import { can } from "@/lib/roles";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 300;

/**
 * Nashr MCP — Streamable HTTP (JSON responses), JSON-RPC 2.0.
 * Connect from Claude Desktop / Claude Code / any MCP client:
 *   URL: https://nashr-tau.vercel.app/api/mcp   Header: Authorization: Bearer nashr_...
 */
const TOOLS = [
  { name: "ask_noor", description: "Talk to Noor, the Gulf marketing agent for this account. She knows the brand, products, seasons and inbox, and can create content, update the brand file, and read/write workspace files. Over MCP she never publishes and never rewrites core memory files, and a change to the offers or removing a banned word waits for the owner's Save in the app.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "generate_content", description: "Create items in the approval inbox. Marketing (Noor): weekly_plan | social (10 posts) | article | whatsapp (3) | ads (5) | gbp (3) | cart_recovery (5, needs a synced Salla or Shopify store). Sales (Sami): sales_script | lead_qualifier | followup_seq. Finance (Razan): pricing_review | unit_economics | cash_forecast. Growth (Faris): gtm_plan | growth_experiments | retention_play. Reports (Dana): weekly_report | board_deck | dashboard_spec. Executive (Majed): strategy_review | okrs | decision_memo. Product (Layan): prd | roadmap | feedback_synthesis | onboarding_flow. Deducts credits.", inputSchema: { type: "object", properties: { type: { type: "string", enum: Object.keys(TASK_COST) }, notes: { type: "string" } }, required: ["type"] } },
  { name: "list_inbox", description: "List inbox items with status.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "approved", "rejected", "all"] } } } },
  { name: "read_file", description: "Read a workspace file (brand.md, products.md, strategy.md, market-research.md, preferences.md).", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_files", description: "List workspace files.", inputSchema: { type: "object", properties: {} } },
  { name: "get_brand_rules", description: "The active brand's rules as structured data: name, dialect and languages, tone, audience, products, offers, preferred words, channels, and the banned words Thakeen enforces in code. Call this before writing anything for this brand in any tool, and write to it. Free, no credits.", inputSchema: { type: "object", properties: {} } },
  { name: "check_brand", description: "Check a draft against the active brand's rules with the same code Thakeen's approve and publish buttons use. Returns pass or the rules that fired, each with the matched word and where it appears. Use it on anything you wrote for this brand before handing it over. Free, no credits.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The draft to check (up to 20,000 characters)." }, type: { type: "string", enum: Object.keys(TASK_COST), description: "Optional Thakeen item type. Internal documents (plans, memos) are not held for quoting a banned word; leave empty to check as customer-facing copy." }, channel: { type: "string", description: "Optional channel (whatsapp, email, sms, instagram…). Defaults to the type. A personalisation slot such as {{1}} or [name] passes only on whatsapp, email, sms and call drafts, and is never published; an unfilled placeholder such as [رقم] or [date] never passes." } }, required: ["text"] } },
  // Reem's to-do tools: free, no model call, the bearer's active brand only; none of them completes, deletes, restores
  // or reopens, and none reads or writes a contact's phone number. handoff_note is chat only.
  ...SEC_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.schema })),
  { name: "save_draft", description: `Save one draft you wrote into the owner's Thakeen approvals inbox as a pending item, for the owner to approve, edit or reject. Nothing is published and nothing is approved automatically. The brand rules are checked in code on save: a draft with a banned word is kept but held, and the answer names the rule, so run check_brand first and fix it. One item per call. Free, no credits, no model call; limited to ${DRAFTS_PER_HOUR} drafts an hour per account.`, inputSchema: { type: "object", properties: { type: { type: "string", enum: Object.keys(TASK_COST), description: "Thakeen item type, e.g. social, article, whatsapp, ads, gbp." }, channel: { type: "string", description: "Optional short channel name: instagram, snapchat, tiktok, x, whatsapp, blog, meta… Defaults to the type." }, title: { type: "string", description: `Optional short title (up to ${DRAFT_LIMITS.title} characters). Defaults to the first line of the body.` }, body: { type: "string", description: `The draft text, ready to use (up to ${DRAFT_LIMITS.body} characters).` }, notes: { type: "string", description: `Optional note for the owner: what this draft is for (up to ${DRAFT_LIMITS.notes} characters).` }, lang: { type: "string", enum: ["ar", "en"], description: "Optional language of the draft. Defaults to the brand's first language." } }, required: ["type", "body"] } },
];

// The role each tool needs is MCP_TOOL_ACTION in src/lib/mcp.ts; a tool missing from it is refused.

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result }, { headers: CORS });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version" };
const err = (id: Rpc["id"], code: number, message: string, status = 200) => {
  const headers: Record<string, string> = { ...CORS };
  if (status === 401) headers["WWW-Authenticate"] = `Bearer resource_metadata="${process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app"}/.well-known/oauth-protected-resource"`;
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers });
};
export async function OPTIONS() { return new NextResponse(null, { headers: CORS }); }
const text = (s: string) => ({ content: [{ type: "text", text: s }] });

export async function GET() {
  return NextResponse.json({ name: "thakeen", version: "0.3.0", transport: "streamable-http", auth: ["oauth2.1 (PKCE, DCR) — see /.well-known/oauth-authorization-server", "personal bearer token from /app/mcp"], tools: TOOLS.map((t) => t.name) }, { headers: CORS });
}

export async function POST(req: Request) {
  const deadline = deadlineFor(maxDuration);
  let body: Rpc | Rpc[];
  try { body = await req.json(); } catch { return err(null, -32700, "Parse error", 400); }
  if (Array.isArray(body)) return err(null, -32600, "Batch not supported", 400);
  const { id, method, params = {} } = body;

  if (method === "initialize") return ok(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "thakeen", version: "0.3.0" } });
  if (method === "notifications/initialized" || method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  const user = await userFromBearer(req);
  if (!user) return err(id, -32001, "Unauthorized: connect via OAuth (this server advertises /.well-known/oauth-authorization-server) or add Authorization: Bearer <personal token from /ar/app/mcp>", 401);

  if (method !== "tools/call") return err(id, -32601, "Method not found");
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const need = Object.prototype.hasOwnProperty.call(MCP_TOOL_ACTION, name) ? MCP_TOOL_ACTION[name] : null;
  if (!need) return err(id, -32602, "Unknown tool");
  if (!can(user, need)) return ok(id, { ...text("Not allowed: this tool needs a higher role in the account. Nothing was done."), isError: true });
  try {
    switch (name) {
      case "ask_noor": {
        // The web chat's limits on the message itself: trimmed, at most 4,000 characters, never empty.
        const message = String(args.message ?? "").trim().slice(0, 4000);
        if (!message) return ok(id, { ...text("Empty message. Nothing was sent."), isError: true });
        // The web chat's gates, in its order (rules 330-331): a bearer token must not be a way around an ended trial or a
        // cheaper way to spend the same models. Answered as a tool error, like MCP generate_content's trial_over: a
        // JSON-RPC client reads the result, not an HTTP status. The link is absolute: it is read outside the app.
        if (trialOver(user)) return ok(id, { ...text(chatRefusedText("trial", user.lang, { origin: ORIGIN() })), isError: true });
        const slow = await chatRefusal(user);
        if (slow) return ok(id, { ...text(chatRefusedText(slow, user.lang, { cap: CHAT_CAPS[slow] })), isError: true });
        // The same monthly allowance too, shared with the app (src/lib/chat-allowance.ts), before chat() saves the message.
        const gate = await reserveChatTurn(user);
        if (!gate.ok) return ok(id, { ...text(refusalText(gate)), isError: true });
        // A connected app is talking: its activity rows say so (`tokenBy`), not "owner". As "mcp": the words come from
        // another assistant, so publishing and core-memory writes are refused in runTool, and a change to the offers or a
        // banned-word removal waits for the owner's Save in the app.
        const { message: m, chat: status, charged } = await runChatTurn(user, gate, () => chat(user, message, undefined, "noor", { by: tokenBy(user), via: "mcp", deadline }));
        const low = gate.mode === "overflow"
          ? `\n\n[chat: this month's ${status.allowance} messages are used; this message continued on credits and was billed ${charged} credit${charged === 1 ? "" : "s"}]`
          : status.left <= Math.ceil(status.allowance / 10) ? `\n\n[chat: ${status.left} of ${status.allowance} messages left ${status.period === "trial" ? "in the trial" : "this month"}]` : "";
        return ok(id, text(m.content + (m.actions?.length ? `\n\n[actions: ${m.actions.join(", ")}]` : "") + low));
      }
      case "generate_content": {
        if (!isTaskType(args.type)) return ok(id, { ...text("Unknown type."), isError: true });
        const type = args.type;
        // The request's own deadline bounds the batch's cross-agent review (notes only, skipped when too little is left).
        const r = await generateBatch(user, user.scope ?? user.email, { type, notes: String(args.notes ?? ""), source: "chat", via: "mcp", by: tokenBy(user), deadline });
        // A tool error, like insufficient credits: a JSON-RPC client reads the result, not an HTTP status.
        if (!r.ok) {
          switch (r.reason) {
            case "paused": return ok(id, { ...text("Content generation is paused for now. No credits were used."), isError: true });
            case "no_brand": return ok(id, { ...text("No brand file yet. Run onboarding in the app first."), isError: true });
            case "trial_over": return ok(id, { ...text("The trial has ended. Subscribe in the app to keep generating."), isError: true });
            case "missing_data": return ok(id, { ...text("No abandoned-cart data yet: connect Salla or Shopify and sync sales from Reports in the app first. No credits were used."), isError: true });
            case "agent_cap": return ok(id, { ...text(`${agentById(r.agent).name.en} reached the monthly credit cap the owner set in Governance (${r.spent} of ${r.cap} credits this month). No credits were used. The owner can raise the cap on the Governance page or wait for next month.`), isError: true });
            case "no_credits": return ok(id, { ...text(`Insufficient credits: need ${r.need}, have ${r.credits}.`), isError: true });
            // Refunded already; answered as a tool error by the catch below.
            case "failed": throw r.error;
          }
        }
        return ok(id, text(`Created ${r.tasks.length} ${type} item(s). Credits left: ${user.credits}.\n\n` + r.tasks.map((i) => `## ${i.title} (${i.channel})\n${i.body}`).join("\n\n")));
      }
      case "list_inbox": {
        const status = String(args.status ?? "pending");
        const tasks = (await listTasks((user.scope ?? user.email))).filter((t) => status === "all" || t.status === status).slice(0, 30);
        return ok(id, text(tasks.length ? tasks.map((t) => `[${t.id}] ${t.status} · ${t.type}/${t.channel} · ${t.title}\n${(t.editedBody ?? t.body).slice(0, 300)}`).join("\n\n") : "Inbox empty."));
      }
      case "read_file": {
        const f = await readFile((user.scope ?? user.email), String(args.name ?? ""));
        return ok(id, f ? text(f.content) : { ...text("Not found."), isError: true });
      }
      case "list_files": {
        const fs = await listFiles((user.scope ?? user.email));
        return ok(id, text(fs.map((f) => `${f.name} (${f.content.length} chars, ${f.updatedAt.slice(0, 10)})`).join("\n") || "No files."));
      }
      case "get_brand_rules": {
        const brand = await getBrand(user.scope ?? user.email);
        if (!brand) return ok(id, { ...text("No brand file yet. Run onboarding in the app first."), isError: true });
        const rules = brandRules(brand);
        // The owner's own brand file, returned as data for the calling assistant to write within.
        return ok(id, text(JSON.stringify({
          brand: brand.name, industry: brand.industry, city: brand.city, dialect: brand.dialect, languages: brand.languages,
          tone: brand.tone, audience: brand.audience, products: brand.products.slice(0, 3000), offers: brand.offers, valueProp: brand.valueProp ?? "",
          preferredWords: brand.preferred, channels: brand.channels,
          enforced: rules.map((r) => ({ rule: r.id, kind: r.kind, term: r.term, appliesTo: CUSTOMER_FACING })),
          howToUse: "Write in the dialect and tone above. Never use an enforced term in customer-facing copy: Thakeen refuses to approve or publish text that contains one. The same holds for an unfilled placeholder such as [رقم], [date] or [proof needed]: fill it in or leave the sentence out. Personalisation slots such as {{1}} are fine only in WhatsApp, email, SMS and call-script drafts, and are never published. Run check_brand on your draft before handing it over.",
        }, null, 2)));
      }
      case "check_brand": {
        const brand = await getBrand(user.scope ?? user.email);
        if (!brand) return ok(id, { ...text("No brand file yet. Run onboarding in the app first."), isError: true });
        const draft = String(args.text ?? "").slice(0, 20000);
        if (!draft.trim()) return ok(id, { ...text("Nothing to check: pass the draft in `text`."), isError: true });
        const type = isTaskType(args.type) ? args.type : "social";
        // The channel decides whether a personalisation slot such as {{1}} may stay (WhatsApp, email, SMS drafts), as for
        // save_draft, whose channel defaults to the type.
        const channel = (typeof args.channel === "string" && args.channel.trim() ? args.channel.trim().toLowerCase() : type).slice(0, 20);
        const violations = gateTask(brand, { type, channel, body: draft });
        // What the publish button would say: no placeholder of any kind is ever published, a {{1}} slot included.
        const atPublish = gateTask(brand, { type, channel, body: draft }, { publish: true });
        return ok(id, text(JSON.stringify({ pass: violations.length === 0, rulesChecked: brandRules(brand).length, checkedAs: isCustomerFacing(type) ? "customer-facing" : "internal (not held)", violations, summary: explain(violations), publishable: atPublish.length === 0, ...(atPublish.length > violations.length ? { atPublish: explain(atPublish) } : {}) }, null, 2)));
      }
      case "save_draft": {
        // Free and without a model call; the scope is the bearer's, never an argument (src/lib/external-drafts.ts).
        const parsed = parseDraft(args);
        if (!parsed.ok) return ok(id, { ...text(parsed.error), isError: true });
        const saved = await saveExternalDraft(user, parsed.draft);
        if (!saved.ok && saved.reason === "rate") return ok(id, { ...text(`Too many drafts saved in a short time (the limit is ${DRAFTS_PER_HOUR} an hour). Nothing was saved. Wait and try again, or let the owner review what is already in the inbox.`), isError: true });
        if (!saved.ok) return ok(id, { ...text("No brand file yet. Run onboarding in the app first. Nothing was saved."), isError: true });
        return ok(id, text(JSON.stringify(draftReport(saved.task, saved.violations), null, 2)));
      }
      default: {
        if (isSecTool(name)) {
          // The scope is the bearer's (`userFromBearer` sets it), never an argument; `source` is "mcp".
          const r = await runSecretaryTool(user, name, args, { who: { actor: "mcp", via: "mcp" }, lang: user.lang });
          return ok(id, r.isError ? { ...text(r.text), isError: true } : text(r.text));
        }
        return err(id, -32602, "Unknown tool");
      }
    }
  } catch (e) {
    return ok(id, { ...text(e instanceof Error ? e.message : "failed"), isError: true });
  }
}
