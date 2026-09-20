import { NextResponse } from "next/server";
import { currentUser, PLAN_CREDITS, saveUser, sc } from "@/lib/auth";
import { getBrand, listLite, saveBrand, TASK_COST, TASK_COUNT, type TaskType } from "@/lib/brand";
import { db } from "@/lib/db";
import { listBrands, scopeFor } from "@/lib/brands";
import { pmap } from "@/lib/parallel";
import { withUserLock } from "@/lib/credits";

export type EmailPrefs = "all" | "important" | "none";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  // Every brand this account owns, not just the one that happens to be active. Credits are charged against the
  // ACCOUNT (`charge(u.email, ...)` everywhere), but usage was read from a single brand scope and then rendered
  // directly beside the account balance: an agency running three brands saw "Credits used 10 / 2000" above "1970
  // remaining", and the used figure changed when it switched brand while the balance did not. The admin route and
  // wipeAccount already take this union; the profile was the outlier.
  const scopes = (await listBrands(u.email)).map((b) => scopeFor(u.email, b.id));
  const tasks = (await pmap(scopes, (s) => listLite(s, monthStart))).flat();
  const usage: Record<string, { count: number; credits: number }> = {};
  for (const t of tasks) {
    if (new Date(t.createdAt) < monthStart) continue;
    const k = t.type; usage[k] ??= { count: 0, credits: 0 }; usage[k].count++;
  }
  // credits are per batch; convert item counts back to credits via items-per-batch
  for (const k of Object.keys(usage)) { const t = k as TaskType; usage[k].credits = Math.round((usage[k].count / (TASK_COUNT[t] ?? 1)) * (TASK_COST[t] ?? 1)); }
  const images = tasks.filter((t) => t.image).length;
  const prefs = (await db.get<{ emails?: EmailPrefs }>(`profile:${sc(u)}`)) ?? {};
  const { passHash: _p, ...safe } = u; void _p;
  const brand = await getBrand(sc(u));
  const now = new Date();
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return NextResponse.json({
    ok: true, user: safe, usage, images, emails: prefs.emails ?? "all", allowance: PLAN_CREDITS[u.plan], nextReset,
    brand: brand ? { name: brand.name, website: brand.website, sitemap: brand.sitemap ?? "", products: brand.products, audience: brand.audience, tone: brand.tone, valueProp: brand.valueProp ?? "", social: brand.social ?? {} } : null,
  });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string | undefined> & { emails?: EmailPrefs };
  // Inside the lock, on the record as it is NOW. `saveUser` writes the whole user, so mutating the copy this request
  // read at its start would put that request's stale `credits` back over any charge committed in between — the work
  // would be delivered and the charge silently reversed. Same shape as /api/account.
  await withUserLock(u.email, async (x) => {
    if (typeof b.name === "string") x.name = b.name.trim().slice(0, 80);
    if (typeof b.phone === "string" && b.phone.replace(/\D/g, "").length >= 9) x.phone = b.phone.trim().slice(0, 30);
    if (b.lang === "ar" || b.lang === "en") x.lang = b.lang;
    await saveUser(x);
  });
  if (b.emails && ["all", "important", "none"].includes(b.emails)) await db.set(`profile:${sc(u)}`, { emails: b.emails });
  // Brand-level fields shown on the profile (Enrich-style): business name, description, customers, voice, value prop, website, sitemap, social handles.
  const brand = await getBrand(sc(u));
  if (brand) {
    const s = (v: unknown, n = 1000) => String(v ?? "").trim().slice(0, n);
    if (typeof b.business === "string" && b.business.trim()) brand.name = s(b.business, 80);
    if (typeof b.products === "string" && b.products.trim()) brand.products = s(b.products);
    if (typeof b.audience === "string" && b.audience.trim()) brand.audience = s(b.audience);
    if (typeof b.tone === "string" && b.tone.trim()) brand.tone = s(b.tone, 300);
    if (typeof b.valueProp === "string") brand.valueProp = s(b.valueProp, 500);
    if (typeof b.website === "string") brand.website = s(b.website, 200);
    if (typeof b.sitemap === "string") brand.sitemap = s(b.sitemap, 300);
    const social: Record<string, string> = { ...(brand.social ?? {}) };
    for (const k of ["instagram", "snapchat", "tiktok", "x", "linkedin"]) { const v = b[`social_${k}`]; if (typeof v === "string") { if (v.trim()) social[k] = s(v, 80); else delete social[k]; } }
    brand.social = social;
    brand.updatedAt = new Date().toISOString();
    await saveBrand(sc(u), brand);
  }
  return NextResponse.json({ ok: true });
}
