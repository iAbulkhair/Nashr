import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getTool } from "@/lib/tools";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";

export const maxDuration = 60;
const FREE_PER_DAY = 5;

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  const t = getTool(tool);
  if (!t) return NextResponse.json({ ok: false, error: "unknown_tool" }, { status: 404 });
  const u = await currentUser();
  if (!u) {
    const ip = (req.headers.get("x-forwarded-for") ?? "anon").split(",")[0].trim();
    const day = new Date().toISOString().slice(0, 10);
    const n = await db.incrby(`toolrate:${ip}:${day}`, 1);
    if (n > FREE_PER_DAY) return NextResponse.json({ ok: false, error: "rate_limited", limit: FREE_PER_DAY }, { status: 429 });
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const inputs = t.fields.map((f) => `${f.label.en}: ${(b[f.name] ?? "").toString().slice(0, 600)}`).join("\n");
  const lang = b.lang ?? "عربي سعودي";
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: true, output: `[DEV MOCK] ${t.slug}\n${inputs}` });
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: `You are Noor, Nashr's Gulf marketing agent, powering a free tool. Language policy: "${lang}" (عربي سعودي = light Saudi dialect; عربي فصحى = simple MSA; English; عربي + English = Arabic then English). Gulf cultural fit, no invented prices/claims (use [رقم]/[number]), no meta commentary. Output only the deliverable, nicely formatted in plain text.`,
      messages: [{ role: "user", content: `${t.prompt}\n\nINPUTS\n${inputs}` }],
    });
    const output = res.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("\n").trim();
    await db.incrby(`toolusage:${t.slug}`, 1);
    return NextResponse.json({ ok: true, output });
  } catch (e) {
    console.error("tool failed", e);
    return NextResponse.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
