import { NextResponse } from "next/server";
import { currentUser, saveUser, sc } from "@/lib/auth";
import { allowanceOf } from "@/lib/pricing";
import { getBrand, IMAGE_COST, listLite, saveBrand, TASK_COST, TASK_COUNT, type TaskType } from "@/lib/brand";
import { db } from "@/lib/db";
import { listBrands, scopeFor } from "@/lib/brands";
import { pmap } from "@/lib/parallel";
import { withUserLock } from "@/lib/credits";
import { can, forbid, type Action } from "@/lib/roles";
import { saveMember, withMemberLock } from "@/lib/team";
import { chatStatus } from "@/lib/chat-allowance";

export type EmailPrefs = "all" | "important" | "none";

const SOCIAL = ["instagram", "snapchat", "tiktok", "x", "linkedin"] as const;
/** Brand-file fields this form edits (admin and owner: `brand.write`). */
const BRAND_FIELDS = ["business", "products", "audience", "tone", "valueProp", "website", "sitemap", ...SOCIAL.map((k) => `social_${k}`)];

/**
 * GET: the acting person ({name, email, lang, role}) and the account summary everyone in it shares (plan, credits,
 * usage, chat messages, brand). The account-level fields (the owner's phone, revocation stamps, per-agent spend, email preferences)
 * go to the owner only: a member sees their own name and address, never the owner's contact details.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  const a = u.actor!;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  // Every brand this account owns, not just the one that happens to be active. Credits are charged against the
  // ACCOUNT (`charge(u.email, ...)` everywhere), but usage was read from a single brand scope and then rendered
  // directly beside the account balance: an agency running three brands saw "Credits used 10 / 2000" above "1970
  // remaining", and the used figure changed when it switched brand while the balance did not. The admin route and
  // wipeAccount already take this union; the profile was the outlier.
  const scopes = (await listBrands(u.email)).map((b) => scopeFor(u.email, b.id));
  // `chat`: the account's chat messages (src/lib/chat-allowance.ts), the same for every seat: `u.email` is the owner's.
  const [lists, prefs, brand, chat] = await Promise.all([
    pmap(scopes, (s) => listLite(s, monthStart)),
    a.kind === "member" ? Promise.resolve(null) : db.get<{ emails?: EmailPrefs }>(`profile:${sc(u)}`),
    getBrand(sc(u)),
    chatStatus(u),
  ]);
  const tasks = lists.flat();
  const usage: Record<string, { count: number; credits: number }> = {};
  for (const t of tasks) {
    if (new Date(t.createdAt) < monthStart) continue;
    const k = t.type; usage[k] ??= { count: 0, credits: 0 }; usage[k].count++;
  }
  // credits are per batch; convert item counts back to credits via items-per-batch
  for (const k of Object.keys(usage)) { const t = k as TaskType; usage[k].credits = Math.round((usage[k].count / (TASK_COUNT[t] ?? 1)) * (TASK_COST[t] ?? 1)); }
  // Renders: the items with an image or a video this month, and what their renders really charged (`mediaCredits`, what
  // src/lib/media/jobs.ts kept after refunds: an image is 1 or 2 by model, a video 12 or 24), as the owner reports and the
  // founder overview count it. Rows from before mediaCredits existed fall back to the one image credit.
  const month = tasks.filter((t) => new Date(t.createdAt) >= monthStart);
  const images = month.filter((t) => t.image || t.video).length;
  const mediaCredits = Math.round(month.reduce((sum, t) => sum + (t.mediaCredits ?? (t.image ? IMAGE_COST : 0)), 0));
  const now = new Date();
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const me = { name: a.name, email: a.email, lang: a.lang, role: a.role };
  const summary = { plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt, ...(u.renewedAt ? { renewedAt: u.renewedAt } : {}) };
  // The owner (or a founder acting as the owner) gets the account record as before, minus the hash and runtime fields.
  // An Agency deal is shown as its terms only: who set it in the founder console is not the customer's to see.
  const { passHash: _p, actor: _a, deal: _d, referredBy: _r, ...safe } = u; void _p; void _a; void _d; void _r; // _r names the partner's email
  const deal = u.deal ? { deal: { credits: u.deal.credits, priceSar: u.deal.priceSar } } : {};
  const user = a.kind === "member" ? { ...me, ...summary } : { ...safe, ...deal, role: a.role };
  // What this person may do with the password and account forms: a founder viewing the account has the owner role but
  // is refused both (IMPERSONATION_BLOCKED), so the role alone cannot tell the page which forms to offer.
  const may = { passwordChange: can(u, "password.change"), accountDelete: can(u, "account.delete") };
  // `allowance`: the monthly credits the balance renews to (src/lib/pricing.ts), the plan's or an Agency account's deal.
  return NextResponse.json({
    ok: true, me, role: a.role, may, impersonating: a.kind === "founder", user, usage, images, mediaCredits, allowance: allowanceOf(u), nextReset, chat,
    ...(a.kind === "member" ? { account: { email: u.email, name: u.name } } : { emails: prefs?.emails ?? "all" }),
    brand: brand ? { name: brand.name, website: brand.website, sitemap: brand.sitemap ?? "", products: brand.products, audience: brand.audience, tone: brand.tone, valueProp: brand.valueProp ?? "", social: brand.social ?? {} } : null,
  });
}

/**
 * PUT: one form, three owners of the data. Name and interface language are the ACTING person's (a member's go to the
 * member record); phone, the account language that drives lifecycle and billing email, and email preferences are the
 * account's (owner only); the brand fields are the brand file's (admin and owner). Every field sent is checked before
 * anything is written: a request carrying a field the actor may not write is refused whole.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const a = u.actor;
  const b = (await req.json().catch(() => ({}))) as Record<string, string | undefined> & { emails?: EmailPrefs };
  const has = (k: string) => typeof b[k] === "string";
  const needs: Action[] = ["profile.self"];
  if (has("lang")) needs.push(a?.kind === "member" ? "profile.self" : "profile.account");
  if (has("phone") || b.emails !== undefined) needs.push("profile.account");
  if (BRAND_FIELDS.some(has)) needs.push("brand.write");
  for (const action of needs) { const no = forbid(u, action); if (no) return no; }

  const lang = b.lang === "ar" || b.lang === "en" ? b.lang : undefined;
  if (a!.kind === "member") {
    // The member's own record, under its own lock. The owner's name and language are the account's, not theirs.
    const name = has("name") ? b.name!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
    if (name || lang) {
      const done = await withMemberLock(a!.email, async (m) => {
        if (m.memberOf !== u.email) return false;
        if (name) m.name = name;
        if (lang) m.lang = lang;
        await saveMember(m);
        return true;
      });
      if (!done) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  } else if (has("name") || has("phone") || lang) {
    // Inside the lock, on the record as it is NOW. `saveUser` writes the whole user, so mutating the copy this request
    // read at its start would put that request's stale `credits` back over any charge committed in between — the work
    // would be delivered and the charge silently reversed. Same shape as /api/account.
    await withUserLock(u.email, async (x) => {
      if (typeof b.name === "string") x.name = b.name.trim().slice(0, 80);
      if (typeof b.phone === "string" && b.phone.replace(/\D/g, "").length >= 9) x.phone = b.phone.trim().slice(0, 30);
      if (lang) x.lang = lang;
      await saveUser(x);
    });
  }
  if (b.emails && ["all", "important", "none"].includes(b.emails)) await db.set(`profile:${sc(u)}`, { emails: b.emails });
  // Brand-level fields shown on the profile (Enrich-style): business name, description, customers, voice, value prop, website, sitemap, social handles.
  const brand = BRAND_FIELDS.some(has) ? await getBrand(sc(u)) : null;
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
    for (const k of SOCIAL) { const v = b[`social_${k}`]; if (typeof v === "string") { if (v.trim()) social[k] = s(v, 80); else delete social[k]; } }
    brand.social = social;
    brand.updatedAt = new Date().toISOString();
    await saveBrand(sc(u), brand);
  }
  return NextResponse.json({ ok: true });
}
