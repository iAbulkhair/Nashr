import { NextResponse } from "next/server";
import { getTool, toolLang } from "@/lib/tools";
import { meter } from "@/lib/usage";
import { db } from "@/lib/db";
import { allow, clientIp } from "@/lib/rate";
import { currentUser } from "@/lib/auth";
import { MODEL_BUDGET, anthropic, modelState } from "@/lib/model";

export const maxDuration = 60;
const FREE_PER_DAY = 5;
/** A signed-in caller is not anonymous, but this route still makes a real model call and charges no credits. */
export const SIGNED_IN_PER_DAY = 50;

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
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
  if (!(await allow(bucket, limit, 86400))) return NextResponse.json({ ok: false, error: "rate_limited", limit }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const inputs = t.fields.map((f) => `${f.label.en}: ${(b[f.name] ?? "").toString().slice(0, 600)}`).join("\n");
  const lang = toolLang(b.lang);
  if (state === "mock") return NextResponse.json({ ok: true, output: `[DEV MOCK] ${t.slug}\n${inputs}` });
  try {
    // One attempt inside the route's 60 s (rule 335).
    const client = anthropic({ timeoutMs: MODEL_BUDGET.TOOL_MS, maxRetries: 0 });
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: `You are Noor, Thakeen's Gulf marketing agent, powering a free tool. Language policy: "${lang}" (عربي سعودي = light Saudi dialect; عربي فصحى = simple MSA; English; عربي + English = Arabic then English). Gulf cultural fit, no invented prices/claims (use [رقم]/[number]), no meta commentary. Output only the deliverable, nicely formatted in plain text.`,
      messages: [{ role: "user", content: `${t.prompt}\n\nINPUTS\n${inputs}` }],
    });
    const output = res.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("\n").trim();
    // Without this the free tools were invisible to the margin figures in the founder console.
    await meter(u?.email, res.model, "tool", res.usage);
    await db.incrby(`toolusage:${t.slug}`, 1);
    return NextResponse.json({ ok: true, output });
  } catch (e) {
    console.error("tool failed", e);
    return NextResponse.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
