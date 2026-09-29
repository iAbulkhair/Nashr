import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { IMAGE_COST, getBrand, getTask, saveTask } from "@/lib/brand";
import { generateImage } from "@/lib/images";
import { charge, refund } from "@/lib/credits";
import { getGov } from "@/lib/governance";
import { agentForTask } from "@/lib/agents";
import { warnAgentCap } from "@/lib/notifications";

export const maxDuration = 120;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand, gov] = await Promise.all([getTask(sc(u), id), getBrand(sc(u)), getGov(sc(u))]);
  if (!t || !brand) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  // Same gate, same 402, same error string as /api/generate: an ended trial may not spend, and an image costs both
  // credits and real money at fal.ai.
  if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
  // An image is charged to the agent who owns the item it illustrates, against that agent's monthly cap.
  const agent = agentForTask(t.type).id;
  const paid = await charge(u.email, IMAGE_COST, { scope: sc(u), agent, cap: gov.agentCaps[agent] });
  if (!paid.ok) {
    if (paid.reason === "agent_cap") return NextResponse.json({ ok: false, error: "agent_cap", agent, spent: paid.spent, cap: paid.cap }, { status: 402 });
    return NextResponse.json({ ok: false, error: "no_credits", need: IMAGE_COST, have: paid.credits }, { status: 402 });
  }
  await warnAgentCap(u, paid);
  try {
    const img = await generateImage(brand, t, u.email);
    t.imageUrl = img.url;
    t.imagePrompt = img.prompt;
    t.imageProvider = img.provider;
    // The placeholder is what comes back when the image service is unreachable: a coloured card carrying the brand
    // name, not artwork. The owner is shown it — labelled — but is not billed for our outage.
    const credits = img.provider === "placeholder" ? await refund(u.email, IMAGE_COST, paid) : paid.credits;
    await saveTask(sc(u), t);
    await track(u.email, "image");
    return NextResponse.json({ ok: true, task: t, credits, provider: img.provider });
  } catch (e) {
    console.error("image failed", e);
    const credits = await refund(u.email, IMAGE_COST, paid);
    return NextResponse.json({ ok: false, error: "image_failed", credits }, { status: 502 });
  }
}
