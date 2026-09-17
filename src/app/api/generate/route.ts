import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { currentUser, saveUser, sc } from "@/lib/auth";
import { TASK_COST, getBrand, listPreferences, saveTask, type Task, type TaskType } from "@/lib/brand";
import { generate } from "@/lib/noor";
import { memoryBlock } from "@/lib/files";
import { getGov } from "@/lib/governance";

export const maxDuration = 300;

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { type?: string; notes?: string };
  const type = b.type as TaskType;
  if (!(type in TASK_COST)) return NextResponse.json({ ok: false, error: "bad_type" }, { status: 400 });
  const brand = await getBrand(sc(u));
  if (!brand) return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
  if (u.plan === "trial" && new Date(u.trialEnds) < new Date()) return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
  const cost = TASK_COST[type];
  if (u.credits < cost) return NextResponse.json({ ok: false, error: "no_credits", need: cost, have: u.credits }, { status: 402 });

  const gov = await getGov(sc(u));
  let items;
  try {
    items = await generate(type, brand, await listPreferences(sc(u)), b.notes, { memory: await memoryBlock(sc(u)), reviewer: gov.reviewer, noEmDash: gov.noEmDash });
  } catch (e) {
    console.error("generate failed", e);
    return NextResponse.json({ ok: false, error: "generation_failed" }, { status: 502 });
  }
  const lang = brand.languages[0] ?? "ar";
  const created: Task[] = [];
  for (const it of items) {
    const t: Task = { id: randomBytes(8).toString("hex"), type, channel: it.channel, title: it.title, body: it.body, status: gov.autoApprove[type] ? "approved" : "pending", createdAt: new Date().toISOString(), lang };
    await saveTask(sc(u), t, true);
    created.push(t);
  }
  u.credits -= cost;
  await saveUser(u);
  return NextResponse.json({ ok: true, created: created.length, credits: u.credits });
}
