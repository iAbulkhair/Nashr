import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isAgentId } from "@/lib/agents";
import { recordThumb } from "@/lib/evals";

// POST /api/chat/feedback {agent, value: 1|-1, reason?, at?} → thumbs on an agent reply
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { agent?: string; value?: number; reason?: string; at?: string };
  if (!isAgentId(b.agent) || (b.value !== 1 && b.value !== -1)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  await recordThumb(u.email, b.agent, b.value, b.reason, b.at);
  return NextResponse.json({ ok: true });
}
