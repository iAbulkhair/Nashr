import { NextResponse } from "next/server";
import { currentUser, saveUser, sc } from "@/lib/auth";
import { IMAGE_COST, getBrand, getTask, saveTask } from "@/lib/brand";
import { generateImage } from "@/lib/images";

export const maxDuration = 120;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const [t, brand] = await Promise.all([getTask(sc(u), id), getBrand(sc(u))]);
  if (!t || !brand) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (u.credits < IMAGE_COST) return NextResponse.json({ ok: false, error: "no_credits" }, { status: 402 });
  try {
    const img = await generateImage(brand, t);
    t.imageUrl = img.url;
    t.imagePrompt = img.prompt;
    await saveTask(sc(u), t);
    u.credits -= IMAGE_COST;
    await saveUser(u);
    return NextResponse.json({ ok: true, task: t, credits: u.credits, provider: img.provider });
  } catch (e) {
    console.error("image failed", e);
    return NextResponse.json({ ok: false, error: "image_failed" }, { status: 502 });
  }
}
