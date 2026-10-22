import { NextResponse } from "next/server";
import { SIGNED_IN_PER_DAY, getTool, toolLang } from "@/lib/tools";
import { metered } from "@/lib/metered";
import { db } from "@/lib/db";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { currentUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { usageWho } from "@/lib/usage";
import { MODEL_BUDGET, anthropic, modelState, until } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { route } from "@/lib/models/route";

export const maxDuration = 60;
const FREE_PER_DAY = 5;

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const { tool } = await ctx.params;
  const t = getTool(tool);
  if (!t) return NextResponse.json({ ok: false, error: "unknown_tool" }, { status: 404 });
  // Before the rate limit: a refused call must not use up a visitor's daily allowance.
  const state = modelState();
  if (state === "paused") return NextResponse.json({ ok: false, error: "paused" }, { status: 503 });
  const u = await currentUser();
  // Every caller gets a ceiling. Signing up is free and unthrottled beyond five accounts per IP per hour, so leaving
  // authenticated callers unlimited made this the cheapest way to spend our model budget: no credits, no trial check.
  const [bucket, limit] = u ? [`tool:u:${u.email}`, SIGNED_IN_PER_DAY] : [`tool:${clientIp(req)}`, FREE_PER_DAY];
  if (!(await allow(bucket, limit, 86400))) return retryLater({ ok: false, error: "rate_limited", limit }, 86400);
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const inputs = t.fields.map((f) => `${f.label.en}: ${(b[f.name] ?? "").toString().slice(0, 600)}`).join("\n");
  const lang = toolLang(b.lang);
  if (state === "mock") return NextResponse.json({ ok: true, output: `[DEV MOCK] ${t.slug}\n${inputs}` });
  try {
    // One retry, so a passing 529 or 429 does not cost a visitor one of their daily uses, and both attempts (the wait
    // between them included) end by the route's deadline, 15 s inside its 60 (rule 335).
    const client = anthropic({ timeoutMs: MODEL_BUDGET.TOOL_MS, maxRetries: 1 });
    // A stream, so a tool cut by the deadline is metered for what it was billed (rule 980). Without this the free tools
    // were invisible to the margin figures in the founder console.
    const res = await metered(client.messages.stream({
      model: route("tool").model,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: `You are Noor, Thakeen's Gulf marketing agent, powering a free tool. Language policy: "${lang}" (عربي سعودي = light Saudi dialect; عربي فصحى = simple MSA; English; عربي + English = Arabic then English). Gulf cultural fit, no invented prices/claims (use [رقم]/[number]), no meta commentary. Output only the deliverable, nicely formatted in plain text.`,
      messages: [{ role: "user", content: `${t.prompt}\n\nINPUTS\n${inputs}` }],
    }, until(deadline, { cap: MODEL_BUDGET.TOOL_MS })), { email: u ? acct(u) : undefined, kind: "tool", ...(u ? { who: usageWho(u, u.scope) } : {}) });
    const output = res.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("\n").trim();
    // Haiku 5.5 has no server-side refusal fallback: a declined request comes back with no text. Say it failed
    // instead of showing the visitor an empty result.
    if (!output) return NextResponse.json({ ok: false, error: "failed" }, { status: 502 });
    await db.incrby(`toolusage:${t.slug}`, 1);
    return NextResponse.json({ ok: true, output });
  } catch (e) {
    console.error("tool failed", e);
    return NextResponse.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
