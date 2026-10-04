import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { isZone } from "@/lib/zones";
import { forbid } from "@/lib/roles";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, brand: await getBrand(sc(u)) });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // The brand file holds the banned words the approve and publish gates enforce: admin and owner only.
  const no = forbid(u, "brand.write");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as Partial<Brand> & { create?: boolean };
  if (!b.name || !b.industry || !b.products || !b.audience) return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  // Create-only (the first-login game's no-site save, rule 527): a brand that exists, built meanwhile in another tab,
  // is never replaced by the game's five fields.
  if (b.create === true && (await getBrand(sc(u)))) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
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
    ...(b.valueProp ? { valueProp: s(b.valueProp, 500) } : {}),
    ...(b.sitemap ? { sitemap: s(b.sitemap, 300) } : {}),
    ...(b.social && typeof b.social === "object" ? { social: Object.fromEntries(Object.entries(b.social).slice(0, 8).map(([k, v]) => [s(k, 20), s(v, 80)])) } : {}),
    // Only a zone on the fixed list is stored; anything else is dropped and the list falls back to the city.
    ...(isZone(b.timeZone) ? { timeZone: b.timeZone } : {}),
  };
  await saveBrand(sc(u), brand);
  await track(u.email, "onboard");
  return NextResponse.json({ ok: true, brand });
}
