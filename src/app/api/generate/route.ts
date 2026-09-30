import { track } from "@/lib/track";
import { charge, refund } from "@/lib/credits";
import { statsFor } from "@/lib/stats";
import { judgeLater } from "@/lib/judge";
import type { Grounding } from "@/lib/json";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { briefOf, getBrand, listPreferencesFor, saveTask, type Task } from "@/lib/brand";
import { feedbackFor } from "@/lib/feedback";
import { agentForTask } from "@/lib/agents";
import { TASK_COST, isTaskType } from "@/lib/tasks";
import { generate } from "@/lib/noor";
import { memoryBlock } from "@/lib/files";
import { getGov } from "@/lib/governance";
import { missingData } from "@/lib/cart-recovery";
import { initialStatus } from "@/lib/brand-rules";
import { ModelPaused, modelState } from "@/lib/model";
import { warnAgentCap } from "@/lib/notifications";

export const maxDuration = 300;

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Before the charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { type?: string; notes?: string };
  if (!isTaskType(b.type)) return NextResponse.json({ ok: false, error: "bad_type" }, { status: 400 });
  const type = b.type;
  // Governance before the charge: the owner's monthly cap for this agent is checked inside the ledger's lock.
  const [brand, gov] = await Promise.all([getBrand(sc(u)), getGov(sc(u))]);
  if (!brand) return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
  if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
  const missing = await missingData(type, sc(u));
  if (missing) return NextResponse.json({ ok: false, error: missing }, { status: 409 });
  const cost = TASK_COST[type];
  const agent = agentForTask(type).id;
  const paid = await charge(u.email, cost, { scope: sc(u), agent, cap: gov.agentCaps[agent] });
  if (!paid.ok) {
    if (paid.reason === "agent_cap") return NextResponse.json({ ok: false, error: "agent_cap", agent, spent: paid.spent, cap: paid.cap }, { status: 402 });
    return NextResponse.json({ ok: false, error: "no_credits", need: cost, have: paid.credits }, { status: 402 });
  }
  u.credits = paid.credits;
  await warnAgentCap(u, paid);

  let items;
  // Read inside the try: the credits are already charged, and a failed read must reach the refund below.
  let ground: Grounding = { notes: b.notes };
  try {
    const [prefs, memory, stats, feedback] = await Promise.all([listPreferencesFor(sc(u), agent), memoryBlock(sc(u)), statsFor(type, sc(u)), feedbackFor(sc(u), agent, { gov })]);
    ground = { notes: b.notes, memory, stats };
    items = await generate(type, brand, prefs, b.notes, { memory, reviewer: gov.reviewer, noEmDash: gov.noEmDash, meter: u.email, stats, feedback });
  } catch (e) {
    console.error("generate failed", e);
    await track(u.email, "error");
    u.credits = await refund(u.email, cost, paid);
    if (e instanceof ModelPaused) return NextResponse.json({ ok: false, error: "model_paused", credits: u.credits }, { status: 503 });
    return NextResponse.json({ ok: false, error: "generation_failed" }, { status: 502 });
  }
  const lang = brand.languages[0] ?? "ar";
  const brief = briefOf(b.notes);
  const created: Task[] = [];
  for (const it of items) {
    const t: Task = { id: randomBytes(8).toString("hex"), type, channel: it.channel, title: it.title, body: it.body, status: initialStatus(gov.autoApprove[type], brand, { type, channel: it.channel, title: it.title, body: it.body }), createdAt: new Date().toISOString(), lang, source: "manual", ...(brief ? { brief } : {}) };
    await saveTask(sc(u), t, true);
    created.push(t);
  }
  judgeLater(sc(u), u.email, brand, created, undefined, ground);
  await track(u.email, "generate");
  return NextResponse.json({ ok: true, created: created.length, credits: u.credits });
}
