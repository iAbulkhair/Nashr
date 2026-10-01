import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isAgentId } from "@/lib/agents";
import { recordThumb } from "@/lib/evals";
import { allow, FEEDBACK_PER_HOUR } from "@/lib/rate";

// POST /api/chat/feedback {agent, value: 1|-1, reason?, at?} → thumbs on an agent reply
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Per account, before the body is read: every thumb is a write to the brand's feedback log.
  if (!(await allow(`chatfeedback:${u.email}`, FEEDBACK_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { agent?: string; value?: number; reason?: string; at?: string };
  if (!isAgentId(b.agent) || (b.value !== 1 && b.value !== -1)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  // Against the workspace the chat ran in: chat history is per brand, so a thumb on it is too.
  await recordThumb(sc(u), b.agent, b.value, b.reason, b.at);
  return NextResponse.json({ ok: true });
}
