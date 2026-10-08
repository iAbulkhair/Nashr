import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask } from "@/lib/brand";
import { errCode, mediaResponse, renderVideo, startThrew } from "@/lib/media/start";
import { maybeSweep } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { deadlineFor } from "@/lib/media/keys";

/** Prompt (20 s) plus submit (20 s) plus admission must fit under the deadline, 15 s below this ceiling (spec A23). */
export const maxDuration = 120;

/** A clip for one inbox item from the model the owner picked. It renders for minutes: the answer is 202 and the inbox polls. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand] = await Promise.all([getTask(sc(u), id), getBrand(sc(u))]);
  if (!t || !brand) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b: unknown = await req.json().catch(() => ({}));
  const model = b && typeof b === "object" ? (b as { model?: unknown }).model : undefined;
  // The engine owns the charge and the one refund. A throw after the charge leaves a durable job that a poll or sweep
  // settles, so the answer points the inbox at it (startThrew) rather than reporting a refund that has not happened.
  try {
    const { status, body, headers } = mediaResponse(await renderVideo(u, t, brand, model, { deadline }));
    return NextResponse.json(body, { status, headers });
  } catch (e) {
    console.error("video route", errCode(e));
    const { status, body } = await startThrew(u, t.id, "video");
    return NextResponse.json(body, { status });
  } finally {
    after(() => maybeSweep(mediaDeps(), deadline));
  }
}
