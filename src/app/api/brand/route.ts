import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, brand: await getBrand(sc(u)) });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<Brand>;
  if (!b.name || !b.industry || !b.products || !b.audience) return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  const s = (v: unknown, n = 1000) => String(v ?? "").slice(0, n);
  const brand: Brand = {
    name: s(b.name, 80),
    website: s(b.website, 200),
    industry: s(b.industry, 60),
    dialect: (["msa", "saudi", "emirati", "kuwaiti", "english"].includes(String(b.dialect)) ? b.dialect : "saudi") as Brand["dialect"],
    languages: Array.isArray(b.languages) && b.languages.length ? (b.languages.filter((l) => l === "ar" || l === "en") as ("ar" | "en")[]) : ["ar"],
    tone: s(b.tone, 300),
    products: s(b.products),
    audience: s(b.audience),
    offers: s(b.offers),
    competitors: s(b.competitors, 400),
    banned: s(b.banned, 400),
    preferred: s(b.preferred, 400),
    channels: Array.isArray(b.channels) ? b.channels.map((c) => s(c, 20)).slice(0, 10) : [],
    city: s(b.city, 60),
    updatedAt: new Date().toISOString(),
  };
  await saveBrand(sc(u), brand);
  return NextResponse.json({ ok: true, brand });
}
