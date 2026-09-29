import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask } from "@/lib/brand";
import { errCode, mediaResponse, renderImage, startThrew } from "@/lib/media/start";
import { maybeSweep } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 120;

/** An image for one inbox item, from the model the owner picked (the default without one). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // One deadline for the whole request, 15 s under the ceiling (spec A23): every step inside gets min(its max, time left).
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand] = await Promise.all([getTask(sc(u), id), getBrand(sc(u))]);
  if (!t || !brand) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b: unknown = await req.json().catch(() => ({}));
  const model = b && typeof b === "object" ? (b as { model?: unknown }).model : undefined;
  // The engine charges before the render, to the agent that owns the item and under the owner's monthly cap for that
  // agent (402 agent_cap, as /api/generate), and refunds exactly once when it fails, so nothing here touches credits. A
  // throw after the charge leaves a durable job, not yet refunded, that the next poll or a sweep settles: the answer
  // points the inbox at it and never says credits were returned.
  try {
    const { status, body } = mediaResponse(await renderImage(u, t, brand, model, { deadline }));
    return NextResponse.json(body, { status });
  } catch (e) {
    console.error("image route", errCode(e));
    const { status, body } = await startThrew(u, t.id, "image");
    return NextResponse.json(body, { status });
  } finally {
    after(() => maybeSweep(mediaDeps(), deadline));
  }
}
