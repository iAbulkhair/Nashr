import { NextResponse } from "next/server";
import { currentUser, saveUser, sc, type User } from "@/lib/auth";
import { allowanceOf } from "@/lib/pricing";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { monthUsage } from "@/lib/month-usage";
import { withBrandLock } from "@/lib/brand-proposals";
import { db } from "@/lib/db";
import { withUserLock } from "@/lib/credits";
import { can, forbid, type Action } from "@/lib/roles";
import { saveMember, withMemberLock } from "@/lib/team";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { openLots, topupBalance } from "@/lib/topups";

export type EmailPrefs = "all" | "important" | "none";

const SOCIAL = ["instagram", "snapchat", "tiktok", "x", "linkedin"] as const;
/** Brand-file fields this form edits (admin and owner: `brand.write`). */
const BRAND_FIELDS = ["business", "products", "audience", "tone", "valueProp", "website", "sitemap", ...SOCIAL.map((k) => `social_${k}`)];

/** The brand fields the profile shows, as GET answers them and PUT answers what it saved. */
const brandView = (brand: Brand | null) =>
  brand ? { name: brand.name, website: brand.website, sitemap: brand.sitemap ?? "", products: brand.products, audience: brand.audience, tone: brand.tone, valueProp: brand.valueProp ?? "", social: brand.social ?? {} } : null;

/**
 * The account fields GET sends (rule 787), named one by one: the stored record is never spread, so a field added to `User`
 * later (a founder's note, a billing internal) stays on the server until someone adds it here on purpose, and a rollback
 * to this build cannot send a field it has never heard of. `SUMMARY` is what every seat reads (plan, balance, trial end,
 * signup day, last renewal); the owner's record adds the contact fields the form edits.
 */
const SUMMARY = ["plan", "credits", "trialEnds", "createdAt", "renewedAt"] as const satisfies readonly (keyof User)[];
const OWNER = [...SUMMARY, "name", "email", "lang", "phone"] as const satisfies readonly (keyof User)[];
/** The named fields of `u` that are set, and nothing else. */
const pick = <K extends keyof User>(u: User, keys: readonly K[]) => {
  const out: Partial<Pick<User, K>> = {};
  for (const k of keys) if (u[k] !== undefined) out[k] = u[k];
  return out;
};

/** A short name or a person's name: no control characters, trimmed, capped. */
const line = (v: string, n: number) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
/** The phone check the profile has always made: at least 9 digits (signup applies the same one, where the phone is optional). */
const phoneOk = (v: string | undefined) => (v ?? "").replace(/\D/g, "").length >= 9;

/**
 * GET: the acting person ({name, email, lang, role}) and the account summary everyone in it shares (plan, credits,
 * usage, chat messages, brand). The account-level fields (the owner's phone, the deal's terms, email preferences) go to
 * the owner only: a member sees their own name and address, never the owner's contact details. Neither gets a field of
 * the stored record that `SUMMARY` or `OWNER` does not name (rule 787).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  const a = u.actor!;
  // This month's usage across every brand of the account (src/lib/month-usage.ts, shared with the billing page).
  // `chat`: the account's chat messages (src/lib/chat-allowance.ts), the same for every seat: `u.email` is the owner's.
  const [{ usage, images, mediaCredits, nextReset }, prefs, brand, chat] = await Promise.all([
    monthUsage(u),
    a.kind === "member" ? Promise.resolve(null) : db.get<{ emails?: EmailPrefs }>(`profile:${sc(u)}`),
    getBrand(sc(u)),
    chatStatus(u, route("chat").model),
  ]);
  const me = { name: a.name, email: a.email, lang: a.lang, role: a.role };
  const summary = pick(u, SUMMARY);
  // The owner (or a founder acting as the owner) gets the fields in `OWNER` and nothing else of the record (rule 787):
  // never the hash, the revocation stamps, per-agent spend, billing internals, a founder grant (rule 783) or the partner
  // who referred the account. An Agency deal is shown as its terms only: who set it in the founder console is not the
  // customer's to see. Top-up packs likewise (rule 453): each pack's size, what is left and when it expires, nothing
  // else (`topupBalance`); what was paid, the payment reference, the payment id and who activated the pack stay with the founder.
  const deal = u.deal ? { deal: { credits: u.deal.credits, priceSar: u.deal.priceSar } } : {};
  // A refunded pack holds nothing and is not sent (`openLots`, rule 460).
  const packs = u.topups?.length ? { topups: openLots(u).map(topupBalance) } : {};
  // A member sees the same packs (the billing page shows them to every seat): the profile's credit card splits the
  // balance into plan credits and top-up credits for everyone.
  const user = a.kind === "member" ? { ...me, ...summary, ...packs } : { ...pick(u, OWNER), ...deal, ...packs, role: a.role };
  // What this person may do with the password and account forms: a founder viewing the account has the owner role but
  // is refused both (IMPERSONATION_BLOCKED), so the role alone cannot tell the page which forms to offer.
  const may = { passwordChange: can(u, "password.change"), accountDelete: can(u, "account.delete") };
  // `allowance`: the monthly credits the balance renews to (src/lib/pricing.ts), the plan's or an Agency account's deal.
  return NextResponse.json({
    ok: true, me, role: a.role, may, impersonating: a.kind === "founder", user, usage, images, mediaCredits, allowance: allowanceOf(u), nextReset, chat,
    ...(a.kind === "member" ? { account: { email: u.email, name: u.name } } : { emails: prefs?.emails ?? "all" }),
    brand: brandView(brand),
  });
}

/**
 * PUT: one form, three owners of the data. Name and interface language are the ACTING person's (a member's go to the
 * member record); phone, the account language that drives lifecycle and billing email, and email preferences are the
 * account's (owner only); the brand fields are the brand file's (admin and owner). Every field sent is checked before
 * anything is written: a request carrying a field the actor may not write is refused whole, and so is one with a value
 * that cannot be saved as sent (400 `required` for an empty name, business name or phone, 400 `bad_phone` for a phone
 * with fewer than 9 digits, 400 `read_only` for `email`), naming the field. Full name, business name, mobile phone and
 * email are required (founder decision, 2026-10-01): the email is the login and this form never writes it; the phone
 * is the account's, so every save by the owner (or the founder acting as the owner) needs a valid one, sent with the
 * request or already stored. An account created without one (signup leaves it optional) still uses the app; its first
 * profile save asks for it. A member's save is not held to it: the phone is not theirs to set. Nothing sent is skipped
 * in silence: an empty description, audience, voice, value proposition, website, sitemap or social handle clears it.
 * The answer carries what was saved, so the page shows the stored values, never what was typed (#16). A save that cannot take its lock (another save of the brand or
 * of the person held it for the whole wait) answers 409 `busy`, and the lock is taken before the first write, so that
 * answer also means nothing was written.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string | undefined> & { emails?: EmailPrefs };
  const has = (k: string) => typeof b[k] === "string";
  const needs: Action[] = ["profile.self"];
  if (has("lang")) needs.push(u.actor?.kind === "member" ? "profile.self" : "profile.account");
  if (has("phone") || b.emails !== undefined) needs.push("profile.account");
  if (BRAND_FIELDS.some(has)) needs.push("brand.write");
  for (const action of needs) { const no = forbid(u, action); if (no) return no; }
  const a = u.actor!; // `forbid` refuses a user with no actor (fail closed), so one is set from here on

  // Every value is checked before the first write, so a refused request leaves everything as it was.
  const refuse = (error: "required" | "bad_phone" | "read_only", field: string) => NextResponse.json({ ok: false, error, field }, { status: 400 });
  // The email is the login: changing or blanking it is not this form's to do, so a request carrying it is refused.
  if (b.email !== undefined) return refuse("read_only", "email");
  const name = has("name") ? line(b.name!, 80) : undefined;
  if (name === "") return refuse("required", "name");
  const business = has("business") ? line(b.business!, 80) : undefined;
  if (business === "") return refuse("required", "business");
  const phone = has("phone") ? b.phone!.trim().slice(0, 30) : undefined;
  if (phone === "") return refuse("required", "phone");
  if (phone !== undefined && !phoneOk(phone)) return refuse("bad_phone", "phone");
  // The account's phone is required: a save by the owner (or the founder acting as the owner) that does not send one
  // needs a valid one on the record. `u` is the account record; the phone can no longer be cleared, so a check at
  // request start cannot be undone by a save in between.
  if (a.kind !== "member" && phone === undefined && !phoneOk(u.phone)) return refuse("required", "phone");
  const lang = b.lang === "ar" || b.lang === "en" ? b.lang : undefined;
  const brandWrite = BRAND_FIELDS.some(has);

  // The writes, in order: the person's record (under its own lock), the email preference, the brand file. With brand
  // fields the whole save runs inside the brand lock, taken BEFORE the first write: a lock that cannot be taken is the
  // only throw this route expects, and it can now only happen before anything is written (the brand lock outside, the
  // user or member lock as the first write inside), so `busy` below is true when it says nothing was saved.
  const run = async () => {
    let me = { name: a.name, email: a.email, lang: a.lang };
    let account: { phone: string } | undefined;
    if (a.kind === "member") {
      // The member's own record, under its own lock. The owner's name and language are the account's, not theirs.
      if (name || lang) {
        const done = await withMemberLock(a.email, async (m) => {
          if (m.memberOf !== u.email) return false;
          if (name) m.name = name;
          if (lang) m.lang = lang;
          await saveMember(m);
          me = { name: m.name, email: a.email, lang: m.lang };
          return true;
        });
        if (!done) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    } else if (name !== undefined || phone !== undefined || lang) {
      // Inside the lock, on the record as it is NOW. `saveUser` writes the whole user, so mutating the copy this request
      // read at its start would put that request's stale `credits` back over any charge committed in between — the work
      // would be delivered and the charge silently reversed. Same shape as /api/account.
      await withUserLock(u.email, async (x) => {
        if (name !== undefined) x.name = name;
        if (phone !== undefined) x.phone = phone;
        if (lang) x.lang = lang;
        await saveUser(x);
        // The owner (or the founder acting as the owner) sees the account's name and language as their own.
        me = { name: x.name, email: a.email, lang: x.lang };
        account = { phone: x.phone ?? "" };
      });
    }
    let emails: EmailPrefs | undefined;
    if (b.emails && ["all", "important", "none"].includes(b.emails)) { await db.set(`profile:${sc(u)}`, { emails: b.emails }); emails = b.emails; }
    const brand = brandWrite ? await writeBrand() : undefined;
    return NextResponse.json({
      ok: true,
      saved: { me, ...(account ? { phone: account.phone } : {}), ...(emails ? { emails } : {}), ...(brand !== undefined ? { brand } : {}) },
    });
  };
  // Brand-level fields shown on the profile (Enrich-style): business name, description, customers, voice, value prop,
  // website, sitemap, social handles. Read and written under the brand lock `run` holds, so a banned word an agent adds
  // while the form is saved, or a proposal the owner applies, is not overwritten by this request's older copy of the file.
  const writeBrand = async (): Promise<ReturnType<typeof brandView>> => {
    const file = await getBrand(sc(u));
    if (!file) return null;
    const s = (v: string, n = 1000) => v.trim().slice(0, n);
    if (business !== undefined) file.name = business;
    if (has("products")) file.products = s(b.products!);
    if (has("audience")) file.audience = s(b.audience!);
    if (has("tone")) file.tone = s(b.tone!, 300);
    if (has("valueProp")) file.valueProp = s(b.valueProp!, 500);
    if (has("website")) file.website = s(b.website!, 200);
    if (has("sitemap")) file.sitemap = s(b.sitemap!, 300);
    const social: Record<string, string> = { ...(file.social ?? {}) };
    for (const k of SOCIAL) { const v = b[`social_${k}`]; if (typeof v === "string") { if (v.trim()) social[k] = s(v, 80); else delete social[k]; } }
    file.social = social;
    file.updatedAt = new Date().toISOString();
    await saveBrand(sc(u), file);
    return brandView(file);
  };
  try {
    return await (brandWrite ? withBrandLock(sc(u), run) : run());
  } catch (e) {
    // Another save of this brand or this person held the lock for its whole wait (about 3 s). Nothing was written.
    if (e instanceof Error && LOCK_TIMEOUTS.has(e.message)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
}

/** What `withBrandLock`, `withUserLock` and `withMemberLock` throw when their lock stays taken. */
const LOCK_TIMEOUTS = new Set(["brand_lock_timeout", "user_lock_timeout", "team_lock_timeout"]);
