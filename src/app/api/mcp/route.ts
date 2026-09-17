import { charge, refund } from "@/lib/credits";
import { statsFor } from "@/lib/stats";
import { judgeLater } from "@/lib/judge";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { userFromBearer } from "@/lib/mcp";
import { chat } from "@/lib/chat";
import { TASK_COST, getBrand, listPreferences, listTasks, saveTask, type Task, type TaskType } from "@/lib/brand";
import { generate } from "@/lib/noor";
import { listFiles, memoryBlock, readFile } from "@/lib/files";
import { getGov } from "@/lib/governance";

export const maxDuration = 300;

/**
 * Nashr MCP — Streamable HTTP (JSON responses), JSON-RPC 2.0.
 * Connect from Claude Desktop / Claude Code / any MCP client:
 *   URL: https://nashr-tau.vercel.app/api/mcp   Header: Authorization: Bearer nashr_...
 */
const TOOLS = [
  { name: "ask_noor", description: "Talk to Noor, the Gulf marketing agent for this account. She knows the brand, products, seasons and inbox, and can create content, update the brand file, and read/write workspace files.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "generate_content", description: "Create items in the approval inbox. Marketing (Noor): weekly_plan | social (10 posts) | article | whatsapp (3) | ads (5) | gbp (3). Sales (Sami): sales_script | lead_qualifier | followup_seq. Finance (Razan): pricing_review | unit_economics | cash_forecast. Growth (Faris): gtm_plan | growth_experiments | retention_play. Reports (Dana): weekly_report | board_deck | dashboard_spec. Executive (Majed): strategy_review | okrs | decision_memo. Product (Layan): prd | roadmap | feedback_synthesis | onboarding_flow. Deducts credits.", inputSchema: { type: "object", properties: { type: { type: "string", enum: Object.keys(TASK_COST) }, notes: { type: "string" } }, required: ["type"] } },
  { name: "list_inbox", description: "List inbox items with status.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "approved", "rejected", "all"] } } } },
  { name: "read_file", description: "Read a workspace file (brand.md, products.md, strategy.md, market-research.md, preferences.md).", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_files", description: "List workspace files.", inputSchema: { type: "object", properties: {} } },
];

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
  return NextResponse.json({ name: "nashr", version: "0.2.0", transport: "streamable-http", auth: ["oauth2.1 (PKCE, DCR) — see /.well-known/oauth-authorization-server", "personal bearer token from /app/mcp"], tools: TOOLS.map((t) => t.name) }, { headers: CORS });
}

export async function POST(req: Request) {
  let body: Rpc | Rpc[];
  try { body = await req.json(); } catch { return err(null, -32700, "Parse error", 400); }
  if (Array.isArray(body)) return err(null, -32600, "Batch not supported", 400);
  const { id, method, params = {} } = body;

  if (method === "initialize") return ok(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "nashr", version: "0.1.0" } });
  if (method === "notifications/initialized" || method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  const user = await userFromBearer(req);
  if (!user) return err(id, -32001, "Unauthorized: connect via OAuth (this server advertises /.well-known/oauth-authorization-server) or add Authorization: Bearer <personal token from /ar/app/mcp>", 401);

  if (method !== "tools/call") return err(id, -32601, "Method not found");
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "ask_noor": {
        const m = await chat(user, String(args.message ?? ""));
        return ok(id, text(m.content + (m.actions?.length ? `\n\n[actions: ${m.actions.join(", ")}]` : "")));
      }
      case "generate_content": {
        const type = String(args.type) as TaskType;
        if (!(type in TASK_COST)) return ok(id, { ...text("Unknown type."), isError: true });
        const brand = await getBrand((user.scope ?? user.email));
        if (!brand) return ok(id, { ...text("No brand file yet. Run onboarding in the app first."), isError: true });
        const cost = TASK_COST[type];
        const paid = await charge(user.email, cost);
        if (!paid.ok) return ok(id, { ...text(`Insufficient credits: need ${cost}, have ${paid.credits}.`), isError: true });
        user.credits = paid.credits;
        const gov = await getGov((user.scope ?? user.email));
        let items;
        try {
          items = await generate(type, brand, await listPreferences((user.scope ?? user.email)), String(args.notes ?? ""), { memory: await memoryBlock((user.scope ?? user.email)), reviewer: gov.reviewer, noEmDash: gov.noEmDash, meter: user.email, stats: await statsFor(type, user.scope ?? user.email) });
        } catch (e) {
          user.credits = await refund(user.email, cost);
          throw e;
        }
        const created: Task[] = [];
        for (const it of items) {
          const t: Task = { id: randomBytes(8).toString("hex"), type, channel: it.channel, title: it.title, body: it.body, status: gov.autoApprove[type] ? "approved" : "pending", createdAt: new Date().toISOString(), lang: brand.languages[0] ?? "ar", source: "chat" };
          await saveTask((user.scope ?? user.email), t, true);
          created.push(t);
        }
        judgeLater(user.scope ?? user.email, user.email, brand, created);
        return ok(id, text(`Created ${items.length} ${type} item(s). Credits left: ${user.credits}.\n\n` + items.map((i) => `## ${i.title} (${i.channel})\n${i.body}`).join("\n\n")));
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
      default:
        return err(id, -32602, "Unknown tool");
    }
  } catch (e) {
    return ok(id, { ...text(e instanceof Error ? e.message : "failed"), isError: true });
  }
}
