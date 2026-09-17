import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { IMAGE_COST, getBrand, getTask, saveTask } from "@/lib/brand";
import { generateImage } from "@/lib/images";
import { charge, refund } from "@/lib/credits";

export const maxDuration = 120;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand] = await Promise.all([getTask(sc(u), id), getBrand(sc(u))]);
  if (!t || !brand) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const paid = await charge(u.email, IMAGE_COST);
  if (!paid.ok) return NextResponse.json({ ok: false, error: "no_credits", need: IMAGE_COST, have: paid.credits }, { status: 402 });
  try {
    const img = await generateImage(brand, t, u.email);
    t.imageUrl = img.url;
    t.imagePrompt = img.prompt;
    await saveTask(sc(u), t);
    await track(u.email, "image");
    return NextResponse.json({ ok: true, task: t, credits: paid.credits, provider: img.provider });
  } catch (e) {
    console.error("image failed", e);
    const credits = await refund(u.email, IMAGE_COST);
    return NextResponse.json({ ok: false, error: "image_failed", credits }, { status: 502 });
  }
}
