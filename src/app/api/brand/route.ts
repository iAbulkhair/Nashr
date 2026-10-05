import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { isZone } from "@/lib/zones";
import { forbid } from "@/lib/roles";
import { withBrandLock } from "@/lib/brand-proposals";

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
  const s = (v: unknown, n = 1000) => String(v ?? "").slice(0, n);
  try {
    // Read, merge and save under the brand lock (src/lib/brand-proposals.ts), the one a proposal the owner applies and the
    // Profile page's brand fields hold: a change applied while this request runs is never overwritten by an older copy.
    // A field the request does not send keeps the value the file has now.
    const brand = await withBrandLock(sc(u), async () => {
      const cur = await getBrand(sc(u));
      // Create-only (the first-login game's no-site save, rule 527): a brand that exists, built meanwhile in another tab,
      // is never replaced by the game's five fields.
      if (b.create === true && cur) return null;
      const keep = <K extends keyof Brand>(k: K, n: number): string => (b[k] === undefined && cur ? String(cur[k] ?? "") : s(b[k], n));
      const next: Brand = {
        name: s(b.name, 80),
        website: keep("website", 200),
        industry: s(b.industry, 60),
        dialect: (["msa", "saudi", "emirati", "kuwaiti", "english"].includes(String(b.dialect)) ? b.dialect : b.dialect === undefined && cur ? cur.dialect : "saudi") as Brand["dialect"],
        languages: Array.isArray(b.languages) && b.languages.length ? (b.languages.filter((l) => l === "ar" || l === "en") as ("ar" | "en")[]) : b.languages === undefined && cur ? cur.languages : ["ar"],
        tone: keep("tone", 300),
        products: s(b.products),
        audience: s(b.audience),
        offers: keep("offers", 1000),
        competitors: keep("competitors", 400),
        banned: keep("banned", 400),
        preferred: keep("preferred", 400),
        channels: Array.isArray(b.channels) ? b.channels.map((c) => s(c, 20)).slice(0, 10) : b.channels === undefined && cur ? cur.channels : [],
        city: keep("city", 60),
        updatedAt: new Date().toISOString(),
        ...(b.valueProp ? { valueProp: s(b.valueProp, 500) } : b.valueProp === undefined && cur?.valueProp ? { valueProp: cur.valueProp } : {}),
        ...(b.sitemap ? { sitemap: s(b.sitemap, 300) } : b.sitemap === undefined && cur?.sitemap ? { sitemap: cur.sitemap } : {}),
        ...(b.social && typeof b.social === "object" ? { social: Object.fromEntries(Object.entries(b.social).slice(0, 8).map(([k, v]) => [s(k, 20), s(v, 80)])) } : b.social === undefined && cur?.social ? { social: cur.social } : {}),
        // Only a zone on the fixed list is stored; anything else is dropped and the list falls back to the city.
        ...(isZone(b.timeZone) ? { timeZone: b.timeZone } : b.timeZone === undefined && cur?.timeZone ? { timeZone: cur.timeZone } : {}),
      };
      await saveBrand(sc(u), next);
      return next;
    });
    if (!brand) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
    await track(u.email, "onboard");
    return NextResponse.json({ ok: true, brand });
  } catch (e) {
    // Another save of this brand held the lock for its whole wait (about 3 s). Nothing was written.
    if (e instanceof Error && e.message === "brand_lock_timeout") return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
}
