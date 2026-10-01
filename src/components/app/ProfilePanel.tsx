"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, TASK_COUNT, type TaskType } from "@/lib/tasks";
import { MEDIA_MODELS, type MediaKind } from "@/lib/media-catalog";
import { ONBOARD_EXTRA_BRAND_COST, formatCount } from "@/lib/pricing";
import { AGENTS } from "@/lib/agents";
import type { Role } from "@/lib/auth";
import type { ChatStatus } from "@/lib/chat-allowance";
import { paceStart, runway, runwayLine } from "@/lib/usage-view";
import ReadOnlyNote from "./ReadOnlyNote";

/**
 * GET /api/profile. `me` and `role` are the person acting; `user` is the account summary (the owner also gets the
 * account's phone and `emails`, a member gets `account` instead). A PUT carrying a field the actor may not write is
 * refused whole, so the form only submits what this role owns: other fields are hidden or disabled, and disabled
 * controls are left out of FormData.
 */
/** "1–2": the lowest and highest price of a media kind in the catalogue, as the pricing page shows it. */
const mediaRange = (kind: MediaKind) => {
  const c = MEDIA_MODELS.filter((m) => m.kind === kind).map((m) => m.credits);
  const lo = Math.min(...c), hi = Math.max(...c);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
};

type Data = {
  me?: { name: string; email: string; lang: Lang; role: Role };
  role?: Role;
  /** From `can()` on the server: a founder viewing the account holds the owner role yet may do neither. */
  may?: { passwordChange: boolean; accountDelete: boolean };
  impersonating?: boolean;
  account?: { email: string; name: string };
  user: { name: string; email: string; phone?: string; plan: string; credits: number; trialEnds: string; createdAt: string; lang: Lang; renewedAt?: string };
  usage: Record<string, { count: number; credits: number }>; images: number; /** What this month's renders charged (image 1-2, video 12-24 by model). */ mediaCredits?: number; emails?: string;
  allowance: number; nextReset: string;
  /** The account's chat messages (src/lib/chat-allowance.ts), the same for every seat. */
  chat?: ChatStatus;
  brand: { name: string; website: string; sitemap?: string; products: string; audience: string; tone: string; valueProp?: string; social?: Record<string, string> } | null;
};

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return <section className="card"><h2 className="font-display text-lg font-bold">{title}</h2>{sub && <p className="mt-1 text-sm text-ink/60">{sub}</p>}<div className="mt-3">{children}</div></section>;
}
const L = (k: string) => <label className="block text-xs font-semibold uppercase tracking-wide text-ink/50">{k}</label>;

export default function ProfilePanel({ t, lang }: { t: AppDict; lang: Lang }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { fetch("/api/profile").then((x) => x.json()).then((j) => j.ok && setD(j)); }, []);
  if (!d) return <p className="text-ink/60">…</p>;
  const input = "input";
  // Owner-only: phone, account language, email preferences, subscription and deleting the account. Admin+: brand fields.
  const role: Role = d.role ?? d.me?.role ?? "owner";
  const owner = role === "owner";
  const brandEdit = role !== "member";
  const canPassword = d.may?.passwordChange ?? true;
  const canDelete = owner && (d.may?.accountDelete ?? true);
  const blockedNote = ar ? "تغيير كلمة المرور وحذف الحساب موقوفان أثناء تصفّح هذا الحساب كمؤسس." : "Changing the password and deleting the account are off while you view this account as the founder.";
  const me = d.me ?? { name: d.user.name, email: d.user.email, lang: d.user.lang, role };
  const mediaUsed = d.mediaCredits ?? d.images;
  const chat = d.chat;
  // Credits billed this month for chat messages continued on credits (`overflow.credits`): part of the month's use, so
  // they count in the bar, the runway's pace and the table's chat row.
  const chatCredits = chat && Number.isFinite(chat.overflow.credits) ? Math.max(0, chat.overflow.credits) : 0;
  const usedCredits = Object.values(d.usage).reduce((s, x) => s + x.credits, 0) + mediaUsed + chatCredits;
  const pct = Math.min(100, Math.round((usedCredits / Math.max(1, d.allowance)) * 100));
  // Runway lines (rule 315, src/lib/usage-view.ts). The credit pace is the table's: this month's work, counted from the
  // 1st or from signup when later. A trial's chat messages count from signup for the whole trial.
  const trial = d.user.plan === "trial";
  const trialEnd = d.user.trialEnds.slice(0, 10);
  const lineOpts = { lang, trial, nextReset: d.nextReset, trialEnds: trialEnd };
  const creditLine = runwayLine(runway({ used: usedCredits, left: d.user.credits, periodStart: paceStart(d.user.createdAt), resetAt: trial ? null : d.nextReset, trialEnds: d.user.trialEnds }), { ...lineOpts, what: "credits" });
  const chatTrial = chat?.period === "trial";
  const chatPct = chat ? Math.min(100, Math.round((chat.used / Math.max(1, chat.allowance)) * 100)) : 0;
  // Past the allowance with "continue on credits" on, a balance below `overflow.hold` pauses chat; an allowance of 0 with
  // it off means the founder turned chat off for the account, so no renewal date is promised.
  const overflowOn = !!chat && chat.overflow.on && chat.overflow.available;
  const chatOff = !!chat && chat.allowance <= 0;
  const short = overflowOn && d.user.credits < chat.overflow.hold;
  const chatLine = chat ? runwayLine(runway({ used: chat.used, left: chat.left, periodStart: chatTrial ? d.user.createdAt : paceStart(d.user.createdAt), resetAt: chatTrial ? null : d.nextReset, trialEnds: d.user.trialEnds }), { ...lineOpts, trial: chatTrial, what: "messages", overflowOn, chatOff, shortOf: short ? chat.overflow.hold : undefined }) : null;
  const chatOverflowShown = !!chat && (chat.overflow.used > 0 || chatCredits > 0);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    setMsg(res.ok ? (ar ? "تم الحفظ" : "Saved") : (ar ? "خطأ" : "Error"));
    if (fd.lang && fd.lang !== lang) r.push(`/${fd.lang}/app/profile`);
    r.refresh();
  }
  async function password(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setMsg(j.ok ? (ar ? "تم تغيير كلمة المرور" : "Password changed")
      : res.status === 403 ? t.team.errors.forbidden
      : j.error === "wrong_password" ? (ar ? "كلمة المرور الحالية غير صحيحة" : "Current password is wrong")
      : j.error === "weak_password" ? (ar ? "كلمة المرور ضعيفة: 8 أحرف على الأقل، فيها حرف ورقم" : "Password too weak: at least 8 characters, with a letter and a digit")
      : t.team.errors.failed);
    (e.target as HTMLFormElement).reset();
  }
  async function del() {
    const pw = prompt(ar ? "لتأكيد الحذف النهائي اكتب كلمة المرور:" : "To permanently delete, enter your password:");
    if (!pw) return;
    const res = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) { r.push(`/${lang}`); r.refresh(); }
    else setMsg(res.status === 403 ? t.team.errors.forbidden : res.status === 401 ? (ar ? "كلمة المرور غير صحيحة" : "Wrong password") : t.team.errors.failed);
  }
  // One label source for every plan, business included: the sidebar and the billing page read the same names.
  const planLabel = (t.nav.plans as Record<string, string>)[d.user.plan] ?? d.user.plan;
  const rules = d.user.plan === "trial"
    ? (ar ? `تجربتك تشمل ${d.allowance} كريدت لمدة 3 أيام. تنتهي ${d.user.trialEnds.slice(0, 10)}.` : `Your trial includes ${d.allowance} credits for 3 days. Ends ${d.user.trialEnds.slice(0, 10)}.`)
    : (ar ? `خطتك تشمل ${d.allowance} كريدت شهرياً. يتجدد الرصيد في اليوم الأول من كل شهر (UTC). التجديد القادم: ${d.nextReset}.` : `Your plan includes ${d.allowance} credits per month. The balance resets on the 1st of each month (UTC). Next reset: ${d.nextReset}.`);

  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <div><h1 className="page-title">{ar ? "حسابك" : "Your profile"}</h1><p className="mt-1 text-ink/60">{ar ? "إدارة الحساب والتفضيلات وما يعرفه الفريق عن علامتك." : "Manage your account, preferences and what the team knows about your brand."}</p></div>
      {msg && <p role="status" className="rounded-lg bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}

      <Card title={ar ? "استخدام الكريدت" : "Credit usage"} sub={rules}>
        <div className="flex items-center justify-between text-sm"><span>{ar ? "المستخدم" : "Credits used"}</span><span className="font-mono" dir="ltr">{usedCredits} / {d.allowance} ({pct}%)</span></div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-salt-dim"><div className="h-full bg-oasis" style={{ width: `${pct}%` }} /></div>
        {creditLine && <p className="mt-1 text-xs text-ink/60" data-runway="credits">{creditLine}</p>}
        <div className="mt-3 rounded-lg bg-oasis/5 p-3"><span className="font-display text-2xl font-bold text-oasis" dir="ltr">{d.user.credits}</span> <span className="text-sm text-ink/60">{ar ? "كريدت متبقٍ" : "credits remaining"}</span></div>
        {/* The account's chat messages (rule 315): counted apart from credits, shared by every seat. */}
        {chat && (
          <div className="mt-4" data-chat-usage="">
            <div className="flex items-center justify-between text-sm"><span>{chatTrial ? (ar ? "رسائل الدردشة في التجربة" : "Chat messages in your trial") : (ar ? "رسائل الدردشة هذا الشهر" : "Chat messages this month")}</span><span className="font-mono" dir="ltr">{formatCount(chat.used)} / {formatCount(chat.allowance)}</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-salt-dim"><div className={`h-full ${chat.left > 0 ? "bg-oasis" : "bg-saffron"}`} style={{ width: `${chatPct}%` }} /></div>
            {chatLine && <p className="mt-1 text-xs text-ink/60" data-runway="messages">{chatLine}</p>}
            {chatOverflowShown && <p className="mt-1 text-xs text-ink/60" data-chat-overflow-used="">{ar ? `${formatCount(chat.overflow.used)} رسالة إضافية هذا الشهر على الكريدت، خُصم عليها ${formatCount(chatCredits)} كريدت.` : `${formatCount(chat.overflow.used)} more this month, continued on credits: ${formatCount(chatCredits)} ${chatCredits === 1 ? "credit" : "credits"} billed.`}</p>}
          </div>
        )}
        <h3 className="mt-4 text-sm font-semibold">{ar ? "تفصيل الاستخدام" : "Usage breakdown"}</h3>
        <div className="overflow-x-auto"><table className="mt-2 w-full text-sm"><thead className="text-start text-xs text-ink/50"><tr><th className="py-1 text-start">{ar ? "الإجراء" : "Action"}</th><th>{ar ? "كريدت لكل دفعة" : "Credits each"}</th><th>{ar ? "دفعات" : "Used"}</th><th>{ar ? "الإجمالي" : "Total credits"}</th></tr></thead>
          <tbody>
            {AGENTS.map((a) => a.tasks.map((k: TaskType) => (
              <tr key={k} className="border-t border-ink/5"><td className="py-1"><span className="text-xs text-ink/50">{t.agents[a.id].name} · </span>{t.generate.types[k].t}</td><td className="text-center font-mono">{TASK_COST[k]}</td><td className="text-center font-mono">{Math.round((d.usage[k]?.count ?? 0) / TASK_COUNT[k])}</td><td className="text-center font-mono">{d.usage[k]?.credits ?? 0}</td></tr>
            )))}
            {/* The catalogue's prices (src/lib/media-catalog.ts), as the pricing page states them, and what the renders really charged. */}
            <tr className="border-t border-ink/5"><td className="py-1">{ar ? "الصور ومقاطع الفيديو" : "Images and videos"}</td><td className="text-center font-mono" dir="ltr">{mediaRange("image")} · {mediaRange("video")}</td><td className="text-center font-mono">{d.images}</td><td className="text-center font-mono">{mediaUsed}</td></tr>
            {/* Chat messages inside the plan's allowance cost no credits; past it, when the owner turned "continue on
                credits" on, each is billed what it actually cost, at most `overflow.hold`: the month's total is
                `overflow.credits`, counted in the credits used above. */}
            <tr className="border-t border-ink/5" data-chat-row=""><td className="py-1">{ar ? "الدردشة مع الفريق (رسائل خطتك)" : "Chat with the team (your plan's messages)"}</td><td className="text-center font-mono">0</td><td className="text-center font-mono" dir="ltr">{chat ? `${formatCount(chat.used)} / ${formatCount(chat.allowance)}` : "—"}</td><td className="text-center font-mono">0</td></tr>
            {chat && chatOverflowShown && (
              <tr className="border-t border-ink/5" data-chat-overflow-row=""><td className="py-1">{ar ? "رسائل إضافية على الكريدت" : "Extra messages on credits"}</td><td className="text-center font-mono" dir="ltr">≤ {formatCount(chat.overflow.hold)}</td><td className="text-center font-mono">{formatCount(chat.overflow.used)}</td><td className="text-center font-mono" data-chat-overflow-credits="">{formatCount(chatCredits)}</td></tr>
            )}
            <tr className="border-t border-ink/5"><td className="py-1">{ar ? "إعداد علامتك الأولى من الرابط" : "Setting up your first brand from its URL"}</td><td className="text-center font-mono">0</td><td className="text-center font-mono">—</td><td className="text-center font-mono">0</td></tr>
            {/* Not a task, so it is not in the usage counts above: the setup charge shows in the balance only. */}
            <tr className="border-t border-ink/5"><td className="py-1">{ar ? "إعداد كل علامة إضافية من رابطها" : "Setting up each added brand from its URL"}</td><td className="text-center font-mono">{ONBOARD_EXTRA_BRAND_COST}</td><td className="text-center font-mono">—</td><td className="text-center font-mono">—</td></tr>
          </tbody></table></div>
        {owner && d.user.plan === "trial" && <Link href={`/${lang}/app/billing`} className="mt-4 inline-block btn btn-accent btn-sm">{ar ? "ابدأ الاشتراك" : "Start subscription"}</Link>}
      </Card>

      <Card title={ar ? "الاشتراك" : "Subscription"}>
        <p className="text-sm">{owner ? (ar ? "أنت الآن على خطة" : "You're currently on the") : (ar ? "الحساب على خطة" : "The account is on the")} <b>{planLabel}</b>{ar ? "" : " plan"}.</p>
        {!owner && <p className="mt-1 text-sm text-ink/60">{t.billing.ownerOnly}</p>}
        <Link href={`/${lang}/app/billing`} className="mt-3 inline-block btn btn-secondary btn-sm">{owner ? (ar ? "إدارة الاشتراك" : "Manage subscription") : t.billing.title}</Link>
      </Card>

      <form onSubmit={save} className="grid gap-5">
        {owner && <Card title={ar ? "تفضيلات الإيميل" : "Email preferences"} sub={ar ? "تتحكم في إيميلات الوكلاء والمهام المجدولة. إيميلات الحساب والفوترة تصل دائماً." : "Controls emails from your agents and their scheduled tasks. Account and billing emails always come through."}>
          <div className="grid gap-2 text-sm">
            {[["all", ar ? "كل الإيميلات" : "All emails", ar ? "كل ملخص ومتابعة ومهمة مجدولة." : "Every agent and scheduled task email."], ["important", ar ? "المهم فقط" : "Important only", ar ? "الوكيل يقرر ما يستحق الإرسال: الأخطاء وما ينتظر موافقتك؛ التقارير الروتينية تُتجاوز." : "Your agent decides what is worth emailing: errors and items needing approval come through; routine reports are skipped."], ["none", ar ? "لا شيء" : "None", ar ? "إيقاف كل إيميلات الوكلاء والمهام المجدولة." : "Stop all agent and scheduled task emails."]].map(([v, l, s]) => (
              <label key={v} className="flex items-start gap-2 rounded-lg border border-ink/10 p-3"><input type="radio" name="emails" value={v} defaultChecked={d.emails === v} className="mt-1" /><span><b>{l}</b><span className="block text-xs text-ink/60">{s}</span></span></label>
            ))}
          </div>
        </Card>}

        <Card title={ar ? "الحساب" : "Account"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>{L(ar ? "الاسم الكامل" : "Full name")}<input name="name" defaultValue={me.name} className={input} /></div>
            <div>{L(ar ? "اسم النشاط" : "Business name")}<input name="business" defaultValue={d.brand?.name ?? ""} disabled={!brandEdit} className={input} /></div>
            {owner && <div>{L(ar ? "رقم الجوال" : "Phone number")}<input name="phone" defaultValue={d.user.phone ?? ""} dir="ltr" className={input} /></div>}
            <div>{L(ar ? "البريد" : "Email")}<input value={me.email} disabled dir="ltr" className={input + " opacity-60"} /></div>
            <div>{L(owner ? (ar ? "لغة التطبيق والإيميلات" : "App and email language") : (ar ? "لغة التطبيق" : "App language"))}<select name="lang" defaultValue={me.lang} className={input}><option value="ar">العربية</option><option value="en">English</option></select></div>
          </div>
        </Card>

        {!brandEdit && <ReadOnlyNote className="" text={t.readOnly.admin} />}
        {/* A disabled fieldset keeps the brand fields visible and out of the submitted form for members. */}
        <fieldset disabled={!brandEdit} className="grid min-w-0 gap-5">
          <Card title={ar ? "حسابات التواصل" : "Social media"} sub={ar ? "حساباتك لتوليد المحتوى والجدولة." : "Your handles for content generation and scheduling."}>
            <div className="grid gap-3 sm:grid-cols-2">
              {["instagram", "snapchat", "tiktok", "x", "linkedin"].map((k) => <div key={k}>{L(k === "x" ? "X (Twitter)" : k)}<input name={`social_${k}`} defaultValue={d.brand?.social?.[k] ?? ""} dir="ltr" placeholder="@" className={input} /></div>)}
            </div>
          </Card>

          <Card title={ar ? "عن نشاطك" : "About your business"} sub={ar ? "يقرؤه الفريق كله في كل توليد. التفاصيل الكاملة في «ملف العلامة»." : "Read by the whole team on every generation. Full details live in “Brand file”."}>
            <div className="grid gap-3">
              <div>{L(ar ? "وصف النشاط والمنتجات" : "Company description")}<textarea name="products" rows={3} defaultValue={d.brand?.products ?? ""} className={input} placeholder={ar ? "ماذا تبيع ولمن، بجملتين." : "What you sell and to whom, in two sentences."} /></div>
              <div>{L(ar ? "العملاء المستهدفون" : "Target customers")}<textarea name="audience" rows={2} defaultValue={d.brand?.audience ?? ""} className={input} placeholder={ar ? "من عميلك المثالي؟" : "Who are your ideal customers?"} /></div>
              <div>{L(ar ? "صوت العلامة" : "Brand voice")}<input name="tone" defaultValue={d.brand?.tone ?? ""} className={input} placeholder={ar ? "مثال: فاخر وودود، مباشر، شبابي" : "e.g. premium and warm, direct, playful"} /></div>
              <div>{L(ar ? "القيمة المميزة" : "Value proposition")}<textarea name="valueProp" rows={2} defaultValue={d.brand?.valueProp ?? ""} className={input} placeholder={ar ? "لماذا يختارك العميل دون غيرك؟" : "Why does a customer choose you over the alternatives?"} /></div>
            </div>
          </Card>

          <Card title={ar ? "SEO والموقع" : "SEO & website configuration"} sub={ar ? "رابط موقعك وخريطته لروابط داخلية أفضل في المقالات واستيراد المنتجات." : "Your website URL and sitemap for better internal linking in SEO content and product import."}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>{L(ar ? "رابط الموقع" : "Website URL")}<input name="website" defaultValue={d.brand?.website ?? ""} dir="ltr" placeholder="example.com" className={input} /></div>
              <div>{L(ar ? "رابط خريطة الموقع" : "Sitemap URL")}<input name="sitemap" defaultValue={d.brand?.sitemap ?? ""} dir="ltr" placeholder="https://example.com/sitemap.xml" className={input} /></div>
            </div>
          </Card>
        </fieldset>
        <button className="justify-self-start btn btn-primary">{ar ? "حفظ التغييرات" : "Save changes"}</button>
      </form>

      {canPassword ? (
        <form onSubmit={password}><Card title={ar ? "كلمة المرور" : "Password"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="currentPassword" type="password" required placeholder={ar ? "الحالية" : "Current"} className={input} />
            <input name="newPassword" type="password" required minLength={8} placeholder={ar ? "الجديدة (8+)" : "New (8+)"} className={input} />
          </div>
          <button className="mt-4 btn btn-secondary btn-sm">{ar ? "غيّر" : "Change"}</button>
        </Card></form>
      ) : (
        <ReadOnlyNote className="" text={blockedNote} />
      )}

      {d.impersonating ? null : canDelete ? (
        <Card title={ar ? "حذف الحساب" : "Delete account"}>
          <p className="text-sm text-ink/60">{ar ? "يحذف حسابك وكل بياناته نهائياً. لا رجوع." : "Permanently delete your account and all associated data. This action cannot be undone."}</p>
          <button onClick={del} className="mt-3 btn btn-danger btn-sm">{ar ? "احذف حسابي" : "Delete account"}</button>
        </Card>
      ) : (
        <Card title={t.team.leave} sub={t.team.leaveSub}>
          <Link href={`/${lang}/app/team`} className="btn btn-secondary btn-sm">{t.nav.members}</Link>
        </Card>
      )}
    </div>
  );
}
