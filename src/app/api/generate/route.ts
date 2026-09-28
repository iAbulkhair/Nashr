import { track } from "@/lib/track";
import { charge, refund } from "@/lib/credits";
import { statsFor } from "@/lib/stats";
import { judgeLater } from "@/lib/judge";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { getBrand, listPreferences, saveTask, type Task } from "@/lib/brand";
import { TASK_COST, isTaskType } from "@/lib/tasks";
import { generate } from "@/lib/noor";
import { memoryBlock } from "@/lib/files";
import { getGov } from "@/lib/governance";
import { missingData } from "@/lib/cart-recovery";
import { ModelPaused, modelState } from "@/lib/model";

export const maxDuration = 300;

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Before the charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { type?: string; notes?: string };
  if (!isTaskType(b.type)) return NextResponse.json({ ok: false, error: "bad_type" }, { status: 400 });
  const type = b.type;
  const brand = await getBrand(sc(u));
  if (!brand) return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
  if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
  const missing = await missingData(type, sc(u));
  if (missing) return NextResponse.json({ ok: false, error: missing }, { status: 409 });
  const cost = TASK_COST[type];
  const paid = await charge(u.email, cost);
  if (!paid.ok) return NextResponse.json({ ok: false, error: "no_credits", need: cost, have: paid.credits }, { status: 402 });
  u.credits = paid.credits;

  const gov = await getGov(sc(u));
  let items;
  try {
    items = await generate(type, brand, await listPreferences(sc(u)), b.notes, { memory: await memoryBlock(sc(u)), reviewer: gov.reviewer, noEmDash: gov.noEmDash, meter: u.email, stats: await statsFor(type, sc(u)) });
  } catch (e) {
    console.error("generate failed", e);
    await track(u.email, "error");
    u.credits = await refund(u.email, cost);
    if (e instanceof ModelPaused) return NextResponse.json({ ok: false, error: "model_paused", credits: u.credits }, { status: 503 });
    return NextResponse.json({ ok: false, error: "generation_failed" }, { status: 502 });
  }
  const lang = brand.languages[0] ?? "ar";
  const created: Task[] = [];
  for (const it of items) {
    const t: Task = { id: randomBytes(8).toString("hex"), type, channel: it.channel, title: it.title, body: it.body, status: gov.autoApprove[type] ? "approved" : "pending", createdAt: new Date().toISOString(), lang };
    await saveTask(sc(u), t, true);
    created.push(t);
  }
  judgeLater(sc(u), u.email, brand, created);
  await track(u.email, "generate");
  return NextResponse.json({ ok: true, created: created.length, credits: u.credits });
}
