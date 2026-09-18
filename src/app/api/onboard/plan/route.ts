import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import type { PlanItem } from "@/lib/chat";

type Stored = { goal: string; plan: PlanItem[]; at: string };

// GET → the starter plan from onboarding (with "added" flags) or null
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, ...(await db.get<Stored>(`onboardplan:${sc(u)}`)) });
}

// POST {index, added} → mark a plan task as added to the owner's task list
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { index?: number; added?: boolean };
  const s = await db.get<Stored>(`onboardplan:${sc(u)}`);
  if (!s || typeof b.index !== "number" || !s.plan[b.index]) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  s.plan[b.index].added = b.added !== false;
  await db.set(`onboardplan:${sc(u)}`, s);
  return NextResponse.json({ ok: true, plan: s.plan });
}
