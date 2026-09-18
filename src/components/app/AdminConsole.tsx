"use client";
import { Fragment, useEffect, useState } from "react";
import GoldenPanel from "./GoldenPanel";

type U = { email: string; name: string; phone: string; plan: string; credits: number; trialEnds: string; createdAt: string; renewedAt?: string | null; suspended?: boolean; lang?: string; tokens?: number; usd?: number; calls?: number };
type Detail = { user: U; brand: Record<string, unknown> | null; tasks: T[]; usage: { in: number; out: number; calls: number; usd: number; kinds: Record<string, number> }; connections: { provider: string; label?: string; connectedAt?: string }[]; brands: { id: string; name: string; status: string }[]; conversations: number; referrals: number; avgScore: number | null };
type T = { id: string; type: string; channel: string; title: string; status: string; createdAt: string; body: string; editedBody?: string; quality?: { score: number; notes: string } };
type TM = { type: string; n: number; approvalRate: number | null; editRate: number | null; editMagnitude: number | null; published: number; avgScore: number | null; low: number; avgHoursToDecide: number | null };
type AM = { agent: string; n: number; approvalRate: number | null; editRate: number | null; avgScore: number | null; low: number; thumbsUp: number; thumbsDown: number; types: TM[] };

const STR = {
  en: { users: "Users", paying: "Paying", today: "Signed up today", trial: "Trial", cost: "Model cost this month $", tokens: "Tokens this month", calls: "Model calls", suspended: "Suspended", search: "Search email, name, phone, plan…", email: "Email", name: "Name", phone: "Phone", plan: "Plan", credits: "Credits", tokensMo: "Tokens (mo)", costMo: "Cost $ (mo)", trialEnds: "Trial ends", joined: "Joined", addCredits: "+ credits", planNote: "Changing the plan resets the balance to that plan's monthly allowance and starts the renewal cycle (balance resets on the 1st of each month, UTC). Use \"+ credits\" for top-ups within the month. Tokens and cost are this month's real model usage.", quality: "Agent quality · last 30 days · all workspaces", qualityNote: "Approval = approved ÷ decided. Edited = approved items the owner changed (magnitude = % of text changed). Judge = automated score /100 (85+ ready, <70 regenerate). Thumbs = chat replies.", agentType: "Agent / type", items: "Items", approval: "Approval", edited: "Edited", magnitude: "Magnitude", published: "Published", judge: "Judge", low: "<70", hours: "Hours to decide", perWorkspace: "Per workspace", loading: "Loading…", close: "close", impersonate: "Log in as user", extend: "Extend trial", reset: "Reset password", emailsIn: "Emails in", suspend: "Suspend", unsuspend: "Unsuspend", del: "Delete account", usage: "Model usage (month)", trialRenewed: "Trial ends / renewed", integrations: "Integrations", brandsEtc: "Brands · conversations · referrals · judge", brandFile: "Brand file", notCompleted: "— not completed —", generated: "Generated items", approved: "approved", rejected: "rejected", promptCredits: "Credits to add (negative to remove):", promptDays: "Extend trial by days:", promptDelete: "Type the email to permanently delete this account and all its data:", promptTemp: "Temporary password (shown once, send it on WhatsApp):", arabic: "Arabic", english: "English" },
  ar: { users: "المستخدمون", paying: "مشتركون", today: "سجّلوا اليوم", trial: "تجربة", cost: "تكلفة النماذج هذا الشهر $", tokens: "توكنز هذا الشهر", calls: "استدعاءات النماذج", suspended: "موقوفون", search: "ابحث بالبريد أو الاسم أو الجوال أو الخطة…", email: "البريد", name: "الاسم", phone: "الجوال", plan: "الخطة", credits: "الكريدت", tokensMo: "توكنز (الشهر)", costMo: "التكلفة $ (الشهر)", trialEnds: "نهاية التجربة", joined: "انضم", addCredits: "+ كريدت", planNote: "تغيير الخطة يعيد الرصيد إلى مخصص الخطة الشهري ويبدأ دورة التجديد (يتجدد الرصيد في أول كل شهر UTC). استخدم «+ كريدت» للإضافات خلال الشهر. التوكنز والتكلفة هي الاستهلاك الحقيقي للنماذج هذا الشهر.", quality: "جودة الوكلاء · آخر 30 يوماً · كل المساحات", qualityNote: "الاعتماد = معتمد ÷ محسوم. التعديل = عناصر معتمدة غيّرها المالك (الحجم = % النص المتغيّر). الحَكَم = درجة آلية من 100 (85+ جاهز، أقل من 70 أعد التوليد). الإبهام = ردود الدردشة.", agentType: "الوكيل / النوع", items: "عناصر", approval: "اعتماد", edited: "تعديل", magnitude: "الحجم", published: "نُشر", judge: "الحَكَم", low: "<70", hours: "ساعات حتى القرار", perWorkspace: "لكل مساحة", loading: "جارٍ التحميل…", close: "إغلاق", impersonate: "دخول كالمستخدم", extend: "تمديد التجربة", reset: "إعادة تعيين كلمة المرور", emailsIn: "الإيميلات بـ", suspend: "إيقاف", unsuspend: "إلغاء الإيقاف", del: "حذف الحساب", usage: "استهلاك النماذج (الشهر)", trialRenewed: "نهاية التجربة / التجديد", integrations: "التكاملات", brandsEtc: "علامات · محادثات · إحالات · الحَكَم", brandFile: "ملف العلامة", notCompleted: "— غير مكتمل —", generated: "العناصر المولّدة", approved: "معتمد", rejected: "مرفوض", promptCredits: "كريدت للإضافة (سالب للخصم):", promptDays: "تمديد التجربة بالأيام:", promptDelete: "اكتب البريد لحذف الحساب وكل بياناته نهائياً:", promptTemp: "كلمة مرور مؤقتة (تظهر مرة واحدة، أرسلها على واتساب):", arabic: "العربية", english: "الإنجليزية" },
} as const;

type Overview = {
  users: { total: number; new1d: number; new7d: number; new30d: number; activated: number; activationRate: number | null; paying: number; trialActive: number; trialExpired: number; suspended: number };
  engagement: { dau: number; wau: number; mau: number; stickiness: number | null; retention7: number | null };
  funnel: { signups30: number; activated30: number; generated30: number; approved30: number; paid30: number };
  revenue: { mrrSar: number; planMix: Record<string, number>; arpuSar: number | null; creditsUsedMonth: number; modelCostUsd: number; grossMarginPct: number | null };
  events: { date: string; counts: Record<string, number> }[];
  features: Record<string, number>;
  health: { errors7d: number; errorsToday: number; modelCalls: number; avgCostPerCallUsd: number | null };
  recent: { email: string; name: string; plan: string; credits: number; createdAt: string; lastActive: string | null; activated: boolean; events: Record<string, number> }[];
};
const TABS = ["overview", "users", "usage", "billing", "quality", "log"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<"en" | "ar", Record<Tab, string>> = {
  en: { overview: "Overview", users: "Users", usage: "Usage", billing: "Billing", quality: "Quality", log: "Audit log" },
  ar: { overview: "نظرة عامة", users: "المستخدمون", usage: "الاستخدام", billing: "الفوترة", quality: "الجودة", log: "سجل الإجراءات" },
};
const OV: Record<"en" | "ar", Record<string, string>> = {
  en: { total: "Users", new7: "New (7d)", new30: "New (30d)", activated: "Activated (brand file)", dau: "Active today", wau: "Active this week", mau: "Active this month", stickiness: "Stickiness DAU/MAU", retention: "7-day retention", mrr: "MRR (SAR, est.)", arpu: "ARPU (SAR)", credits: "Credits used (month)", cost: "Model cost (USD, month)", margin: "Gross margin", errors: "Errors (7d)", calls: "Model calls (month)", funnel: "Funnel, last 30 days", events: "Events per day, last 14 days", features: "Feature usage (14d)", recent: "Recent users", lastActive: "Last active", planMix: "Plan mix", invoices: "Invoices", invoicesNote: "No payment provider connected. Once Moyasar or Tap is wired, subscriptions, payments, failed charges and refunds appear here. ZATCA tax invoices must be generated by Nashr (VAT number, QR, sequential numbering); neither provider issues them.", export: "Export users CSV", reason: "Reason (logged)", health: "Platform health", log: "Every founder action with before/after and reason", signup: "signup", activated30: "activated", generated: "first batch", approved: "first approval", paid: "paid" },
  ar: { total: "المستخدمون", new7: "جدد (7 أيام)", new30: "جدد (30 يوماً)", activated: "مفعّلون (ملف علامة)", dau: "نشطون اليوم", wau: "نشطون هذا الأسبوع", mau: "نشطون هذا الشهر", stickiness: "الالتصاق DAU/MAU", retention: "احتفاظ 7 أيام", mrr: "الإيراد الشهري المتكرر (ريال، تقدير)", arpu: "متوسط الإيراد لكل مشترك", credits: "كريدت مستهلك (الشهر)", cost: "تكلفة النماذج (دولار، الشهر)", margin: "هامش الربح الإجمالي", errors: "أخطاء (7 أيام)", calls: "استدعاءات النماذج (الشهر)", funnel: "مسار التحويل، آخر 30 يوماً", events: "الأحداث يومياً، آخر 14 يوماً", features: "استخدام المزايا (14 يوماً)", recent: "أحدث المستخدمين", lastActive: "آخر نشاط", planMix: "توزيع الخطط", invoices: "الفواتير", invoicesNote: "لا مزوّد دفع مربوط بعد. عند ربط Moyasar أو Tap تظهر هنا الاشتراكات والمدفوعات والمدفوعات الفاشلة والاسترجاعات. الفواتير الضريبية (ZATCA) يجب أن تولّدها نشر بنفسها (الرقم الضريبي، QR، ترقيم متسلسل)؛ لا يصدرها المزوّدان.", export: "تصدير المستخدمين CSV", reason: "السبب (يُسجَّل)", health: "صحة المنصة", log: "كل إجراء للمؤسس مع قبل/بعد والسبب", signup: "تسجيل", activated30: "تفعيل", generated: "أول دفعة", approved: "أول اعتماد", paid: "دفع" },
};

function Events({ data }: { data: Overview["events"] }) {
  const keys = ["signup", "chat", "generate", "approve"] as const;
  const colors: Record<string, string> = { signup: "var(--color-accent)", chat: "var(--color-inverse-muted)", generate: "var(--color-primary)", approve: "var(--color-danger)" };
  const W = 640, H = 160, PAD = 24;
  const max = Math.max(1, ...data.flatMap((d) => keys.map((k) => d.counts[k] ?? 0)));
  const x = (i: number) => PAD + (data.length > 1 ? (i / (data.length - 1)) * (W - 2 * PAD) : 0);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  return (
    <div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">{keys.map((k) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded" style={{ background: colors[k] }} />{k}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="events">
        {keys.map((k) => <path key={k} d={data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.counts[k] ?? 0).toFixed(1)}`).join(" ")} fill="none" stroke={colors[k]} strokeWidth="2" strokeLinejoin="round" />)}
        {data.length > 0 && [0, Math.floor(data.length / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="currentColor" fillOpacity="0.5">{data[i].date.slice(5)}</text>)}
      </svg>
    </div>
  );
}

export default function AdminConsole({ lang = "en" }: { lang?: "ar" | "en" }) {
  const S = STR[lang];
  const O = OV[lang];
  const [tab, setTab] = useState<Tab>("overview");
  const [ov, setOv] = useState<Overview | null>(null);
  const [log, setLog] = useState<{ actor?: string; email: string; what: string; reason?: string; before?: unknown; after?: unknown; at: string }[] | null>(null);
  const [users, setUsers] = useState<U[] | null>(null);
  const [sel, setSel] = useState<Detail | null>(null);
  const [q, setQ] = useState("");
  const [total, setTotal] = useState<{ usd: number; in: number; out: number; calls: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [evals, setEvals] = useState<{ agents: AM[]; users: { email: string; n: number; approvalRate: number | null; avgScore: number | null }[] } | null>(null);

  async function load() {
    const r = await fetch("/api/admin/plan");
    if (r.status === 401) return setUsers([]);
    const j = await r.json();
    setUsers(j.users);
    if (j.total) setTotal(j.total);
  }
  async function act(email: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const j = await r.json();
    setBusy(false);
    if (!j.ok) { setMsg(`${action} failed: ${j.error ?? r.status}`); return j; }
    if (action === "resetPassword") { window.prompt(`${email}: ${S.promptTemp}`, j.tempPassword); setMsg(`${email}: password reset`); }
    else if (action === "impersonate") { window.location.assign(j.redirect); return j; }
    else if (action === "delete") { setMsg(`${email} deleted`); setSel(null); }
    else setMsg(`${email}: ${action} ✓`);
    await load();
    if (sel && action !== "delete") await open(email);
    return j;
  }
  useEffect(() => {
    void Promise.resolve().then(load);
    fetch("/api/admin/evals").then((r) => r.json()).then((j) => j.ok && setEvals(j)).catch(() => {});
    fetch("/api/admin/overview").then((r) => r.json()).then((j) => j.ok && setOv(j)).catch(() => {});
    fetch("/api/admin/log").then((r) => r.json()).then((j) => j.ok && setLog(j.log)).catch(() => {});
  }, []);

  async function setPlan(email: string, plan: string) {
    const reason = prompt(O.reason, "") ?? "";
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, plan, reason }) });
    setMsg(`${email} → ${plan}`);
    await load();
    setBusy(false);
  }
  async function addCredits(email: string) {
    const n = Number(prompt(S.promptCredits, "100"));
    if (!n) return;
    const reason = prompt(O.reason, "") ?? "";
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, addCredits: n, reason }) });
    setMsg(`${email} +${n} credits`);
    await load();
    setBusy(false);
  }
  async function open(email: string) {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`);
    const j = await r.json();
    if (j.ok) setSel(j);
  }

  // Render the shell at once; each tab shows its own loading state. Waiting for the user list hid the whole console.
  const loadingUsers = users === null;
  const list = users ?? [];
  const paying = list.filter((u) => u.plan !== "trial").length;
  const shown = list.filter((u) => !q || [u.email, u.name, u.phone, u.plan].some((x) => (x ?? "").toLowerCase().includes(q.toLowerCase())));
  const today = list.filter((u) => u.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {[[S.users, loadingUsers ? "…" : list.length], [S.paying, loadingUsers ? "…" : paying], [S.today, loadingUsers ? "…" : today], [S.trial, loadingUsers ? "…" : list.length - paying], [S.cost, total ? total.usd.toFixed(2) : "…"], [S.tokens, total ? `${Math.round((total.in + total.out) / 1000)}k` : "…"], [S.calls, total ? total.calls : "…"], [S.suspended, list.filter((u) => u.suspended).length]].map(([l, v]) => (
          <div key={String(l)} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="font-display text-2xl font-bold text-oasis">{v}</p></div>
        ))}
      </div>
      {msg && <p className="text-sm text-oasis">{msg}</p>}
      <div className="flex flex-wrap gap-1 border-b border-ink/10 text-sm" role="tablist">
        {TABS.map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`px-4 py-2 ${tab === k ? "border-b-2 border-oasis font-semibold text-oasis" : "text-ink/60 hover:text-oasis"}`}>{TAB_LABEL[lang][k]}</button>)}
      </div>

      {tab === "overview" && (!ov ? <p className="text-sm text-ink/50">{S.loading}</p> : (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[[O.total, ov.users.total], [O.new7, ov.users.new7d], [O.activated, `${ov.users.activated} (${ov.users.activationRate ?? "—"}%)`], [O.dau, ov.engagement.dau], [O.wau, ov.engagement.wau], [O.mau, ov.engagement.mau], [O.stickiness, ov.engagement.stickiness === null ? "—" : `${ov.engagement.stickiness}%`], [O.retention, ov.engagement.retention7 === null ? "—" : `${ov.engagement.retention7}%`], [O.mrr, ov.revenue.mrrSar], [O.credits, ov.revenue.creditsUsedMonth], [O.cost, ov.revenue.modelCostUsd.toFixed(2)], [O.errors, ov.health.errors7d]].map(([l, v]) => (
              <div key={String(l)} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="tnum font-display text-2xl font-bold text-oasis">{v}</p></div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <section className="card card-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.events}</h2>
              <Events data={ov.events} />
            </section>
            <section className="card card-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.funnel}</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {[[O.signup, ov.funnel.signups30], [O.activated30, ov.funnel.activated30], [O.generated, ov.funnel.generated30], [O.approved, ov.funnel.approved30], [O.paid, ov.funnel.paid30]].map(([l, v], i, arr) => { const base = Number(arr[0][1]) || 1; const pct = Math.round((Number(v) / base) * 100); return (
                  <li key={String(l)}><div className="flex justify-between text-xs"><span>{l}</span><span className="tnum">{v} · {pct}%</span></div><div className="mt-1 h-2 rounded-full bg-salt-dim"><div className="h-full rounded-full bg-oasis" style={{ width: `${pct}%` }} /></div></li>
                ); })}
              </ul>
            </section>
          </div>
          <section className="card card-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.recent}</h2>
            <table className="mt-2 w-full text-xs"><thead className="text-start text-ink/60"><tr><th className="p-1 text-start">{S.email}</th><th>{S.plan}</th><th>{S.credits}</th><th>{O.activated}</th><th>{O.lastActive}</th><th>chat/generate/approve</th></tr></thead>
              <tbody>{ov.recent.map((u) => <tr key={u.email} className="border-t border-ink/5"><td className="p-1"><button onClick={() => { setTab("users"); open(u.email); }} className="text-oasis underline" dir="ltr">{u.email}</button></td><td>{u.plan}</td><td className="tnum">{u.credits}</td><td>{u.activated ? "✓" : "—"}</td><td className="tnum" dir="ltr">{u.lastActive ? u.lastActive.slice(0, 16).replace("T", " ") : "—"}</td><td className="tnum">{u.events.chat ?? 0}/{u.events.generate ?? 0}/{u.events.approve ?? 0}</td></tr>)}</tbody></table>
          </section>
        </div>
      ))}

      {tab === "usage" && (!ov ? <p className="text-sm text-ink/50">{S.loading}</p> : (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-4">
            {[[O.dau, ov.engagement.dau], [O.wau, ov.engagement.wau], [O.mau, ov.engagement.mau], [O.retention, ov.engagement.retention7 === null ? "—" : `${ov.engagement.retention7}%`]].map(([l, v]) => <div key={String(l)} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="tnum font-display text-2xl font-bold text-oasis">{v}</p></div>)}
          </div>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.features}</h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5 text-sm">{Object.entries(ov.features).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between rounded-lg bg-salt-dim px-3 py-2"><span>{k}</span><span className="tnum font-semibold">{v}</span></li>)}</ul>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.events}</h2>
            <table className="mt-2 w-full text-xs"><thead className="text-ink/60"><tr><th className="p-1 text-start">date</th>{["signup", "login", "onboard", "chat", "generate", "approve", "publish", "connect", "image", "error"].map((e) => <th key={e}>{e}</th>)}</tr></thead>
              <tbody>{ov.events.map((d) => <tr key={d.date} className="border-t border-ink/5"><td className="tnum p-1" dir="ltr">{d.date.slice(5)}</td>{["signup", "login", "onboard", "chat", "generate", "approve", "publish", "connect", "image", "error"].map((e) => <td key={e} className={`tnum text-center ${e === "error" && d.counts[e] ? "text-sadu-deep" : ""}`}>{d.counts[e] ?? ""}</td>)}</tr>)}</tbody></table>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.health}</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-4 text-sm">{[[O.errors, ov.health.errors7d], ["errors today", ov.health.errorsToday], [O.calls, ov.health.modelCalls], ["avg $/call", ov.health.avgCostPerCallUsd ?? "—"]].map(([l, v]) => <div key={String(l)} className="rounded-lg bg-salt-dim px-3 py-2"><p className="text-xs text-ink/60">{l}</p><p className="tnum font-semibold">{v}</p></div>)}</div>
            <p className="mt-2 text-xs text-ink/50">Uptime, p95 latency and cron heartbeats: add Vercel Speed Insights + Better Stack (free tiers), see docs/Admin_Console_Benchmark.md.</p>
          </section>
        </div>
      ))}

      {tab === "billing" && (!ov ? <p className="text-sm text-ink/50">{S.loading}</p> : (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-4">
            {[[O.mrr, ov.revenue.mrrSar], [O.arpu, ov.revenue.arpuSar ?? "—"], [O.cost, ov.revenue.modelCostUsd.toFixed(2)], [O.margin, ov.revenue.grossMarginPct === null ? "—" : `${ov.revenue.grossMarginPct}%`]].map(([l, v]) => <div key={String(l)} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="tnum font-display text-2xl font-bold text-oasis">{v}</p></div>)}
          </div>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.planMix}</h2>
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">{Object.entries(ov.revenue.planMix).map(([k, v]) => <li key={k} className="rounded-full bg-salt-dim px-3 py-1">{k}: <b className="tnum">{v}</b></li>)}</ul>
            <button type="button" onClick={() => window.open("/api/admin/export", "_blank")} className="btn btn-secondary btn-sm mt-3">{O.export}</button>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.invoices}</h2><p className="mt-2 text-sm text-ink/70">{O.invoicesNote}</p></section>
        </div>
      ))}

      {tab === "log" && (
        <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink/60">{O.log}</h2>
          {!log ? <p className="mt-2 text-sm text-ink/50">{S.loading}</p> : log.length === 0 ? <p className="mt-2 text-sm text-ink/50">—</p> : (
            <table className="mt-2 w-full text-xs"><thead className="text-ink/60"><tr><th className="p-1 text-start">at</th><th className="text-start">user</th><th className="text-start">action</th><th className="text-start">before → after</th><th className="text-start">reason</th></tr></thead>
              <tbody>{log.map((l, i) => <tr key={i} className="border-t border-ink/5"><td className="tnum p-1" dir="ltr">{l.at.slice(0, 16).replace("T", " ")}</td><td dir="ltr">{l.email}</td><td>{l.what}</td><td className="tnum" dir="ltr">{l.before !== undefined ? `${JSON.stringify(l.before)} → ${JSON.stringify(l.after)}` : ""}</td><td dir="auto">{l.reason ?? ""}</td></tr>)}</tbody></table>
          )}
        </section>
      )}

      <div className={tab === "users" ? "grid gap-6" : "hidden"}>
      {loadingUsers && <p className="text-sm text-ink/60">{S.loading}</p>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={S.search} className="w-full max-w-md rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm" />
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-salt-dim text-left text-xs uppercase tracking-wide text-ink/60">
            <tr><th className="p-3">{S.email}</th><th>{S.name}</th><th>{S.phone}</th><th>{S.plan}</th><th>{S.credits}</th><th>{S.tokensMo}</th><th>{S.costMo}</th><th>{S.trialEnds}</th><th>{S.joined}</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.email} className={`border-t border-ink/5 ${u.suspended ? "bg-sadu/5" : ""}`}>
                <td className="p-3"><button onClick={() => open(u.email)} className="text-oasis underline">{u.email}</button>{u.suspended && <span className="ms-2 rounded bg-sadu px-1.5 text-xs font-semibold text-white">SUSPENDED</span>}</td>
                <td>{u.name}</td>
                <td className="font-mono text-xs"><a href={`https://wa.me/${u.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="underline">{u.phone}</a></td>
                <td>
                  <select value={u.plan} disabled={busy} onChange={(e) => setPlan(u.email, e.target.value)} className="rounded border border-ink/15 bg-white px-2 py-1">
                    {["trial", "starter", "pro", "agency", "enterprise"].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td className="font-mono">{u.credits}</td>
                <td className="font-mono text-xs" title={`${u.calls ?? 0} model calls`}>{((u.tokens ?? 0) / 1000).toFixed(1)}k</td>
                <td className="font-mono text-xs">{(u.usd ?? 0).toFixed(2)}</td>
                <td className="font-mono text-xs">{u.plan === "trial" ? u.trialEnds.slice(0, 10) : "—"}</td>
                <td className="font-mono text-xs">{u.createdAt.slice(0, 10)}</td>
                <td className="p-3"><button disabled={busy} onClick={() => addCredits(u.email)} className="btn btn-secondary btn-xs">{S.addCredits}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">{S.planNote}</p>
      </div>

      <section className={tab === "quality" ? "card card-sm" : "hidden"}>
        <h2 className="font-display text-lg font-semibold text-oasis">{S.quality}</h2>
        <p className="text-xs text-ink/50">{S.qualityNote}</p>
        {!evals ? <p className="mt-2 text-sm text-ink/50">{S.loading}</p> : (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-salt-dim text-left text-xs uppercase tracking-wide text-ink/60"><tr><th className="p-2">{S.agentType}</th><th>{S.items}</th><th>{S.approval}</th><th>{S.edited}</th><th>{S.magnitude}</th><th>{S.published}</th><th>{S.judge}</th><th>{S.low}</th><th>{S.hours}</th><th>👍/👎</th></tr></thead>
            <tbody>
              {evals.agents.map((a) => (
                <Fragment key={a.agent}>
                  <tr className="border-t border-ink/10 bg-salt/60 font-medium">
                    <td className="p-2">{a.agent}</td><td className="font-mono">{a.n}</td><td className="font-mono">{a.approvalRate ?? "—"}{a.approvalRate !== null && "%"}</td><td className="font-mono">{a.editRate ?? "—"}{a.editRate !== null && "%"}</td><td></td><td></td>
                    <td className={`font-mono ${a.avgScore !== null && a.avgScore < 70 ? "text-sadu" : ""}`}>{a.avgScore ?? "—"}</td><td className="font-mono">{a.low}</td><td></td><td className="font-mono">{a.thumbsUp}/{a.thumbsDown}</td>
                  </tr>
                  {a.types.map((x) => (
                    <tr key={a.agent + x.type} className="border-t border-ink/5 text-ink/70">
                      <td className="p-2 ps-6 font-mono text-xs">{x.type}</td><td className="font-mono">{x.n}</td><td className="font-mono">{x.approvalRate ?? "—"}{x.approvalRate !== null && "%"}</td><td className="font-mono">{x.editRate ?? "—"}{x.editRate !== null && "%"}</td><td className="font-mono">{x.editMagnitude ?? "—"}{x.editMagnitude !== null && "%"}</td><td className="font-mono">{x.published}</td>
                      <td className={`font-mono ${x.avgScore !== null && x.avgScore < 70 ? "text-sadu" : ""}`}>{x.avgScore ?? "—"}</td><td className="font-mono">{x.low}</td><td className="font-mono">{x.avgHoursToDecide ?? "—"}</td><td></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {evals && evals.users.length > 0 && (
          <p className="mt-3 text-xs text-ink/60">{S.perWorkspace}: {evals.users.slice(0, 12).map((u) => `${u.email} (${u.n} items, approval ${u.approvalRate ?? "—"}${u.approvalRate !== null ? "%" : ""}, judge ${u.avgScore ?? "—"})`).join(" · ")}</p>
        )}
      </section>
      {tab === "quality" && <GoldenPanel lang={lang} />}

      {sel && tab === "users" && (
        <div className="rounded-xl border border-oasis/30 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-oasis">{sel.user.email} <span className="text-sm font-normal text-ink/60">· {sel.user.name} · {sel.user.phone} · {sel.user.plan} · {sel.user.credits} credits{sel.user.suspended ? " · SUSPENDED" : ""}</span></h2>
            <button onClick={() => setSel(null)} className="text-sm text-ink/60">{S.close}</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button disabled={busy} onClick={() => act(sel.user.email, "impersonate")} className="rounded-full bg-oasis px-3 py-1 font-semibold text-mist">{S.impersonate}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "extendTrial", { days: Number(prompt(S.promptDays, "7")) || 7 })} className="btn btn-secondary btn-xs">{S.extend}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "resetPassword")} className="btn btn-secondary btn-xs">{S.reset}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "setLang", { lang: sel.user.lang === "ar" ? "en" : "ar" })} className="btn btn-secondary btn-xs">{S.emailsIn} {sel.user.lang === "ar" ? S.english : S.arabic}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, sel.user.suspended ? "unsuspend" : "suspend")} className={`rounded-full px-3 py-1 font-semibold ${sel.user.suspended ? "bg-oasis text-mist" : "border border-sadu text-sadu"}`}>{sel.user.suspended ? S.unsuspend : S.suspend}</button>
            <button disabled={busy} onClick={() => { if (prompt(S.promptDelete) === sel.user.email) act(sel.user.email, "delete"); }} className="btn btn-danger-solid btn-xs">{S.del}</button>
          </div>
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-4">
            <div className="rounded border border-ink/10 p-2"><p className="text-ink/50">{S.usage}</p><p className="font-mono">{Math.round((sel.usage.in + sel.usage.out) / 1000)}k tokens · ${sel.usage.usd.toFixed(2)} · {sel.usage.calls} calls</p><p className="font-mono text-xs text-ink/50">{Object.entries(sel.usage.kinds).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</p></div>
            <div className="rounded border border-ink/10 p-2"><p className="text-ink/50">{S.trialRenewed}</p><p className="font-mono">{sel.user.trialEnds.slice(0, 10)} · {sel.user.renewedAt ?? "—"}</p><p className="font-mono text-xs text-ink/50">joined {sel.user.createdAt.slice(0, 10)}</p></div>
            <div className="rounded border border-ink/10 p-2"><p className="text-ink/50">{S.integrations}</p><p className="font-mono">{sel.connections.length ? sel.connections.map((c) => c.provider).join(", ") : "none"}</p></div>
            <div className="rounded border border-ink/10 p-2"><p className="text-ink/50">{S.brandsEtc}</p><p className="font-mono">{sel.brands.length} · {sel.conversations} · {sel.referrals} · {sel.avgScore ?? "—"}</p></div>
          </div>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-ink/60">{S.brandFile}</h3>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-salt-dim p-3 text-xs" dir="auto">{sel.brand ? JSON.stringify(sel.brand, null, 2) : "— not completed —"}</pre>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-ink/60">{S.generated} ({sel.tasks.length}) · {S.approved} {sel.tasks.filter((t) => t.status === "approved").length} · {S.rejected} {sel.tasks.filter((t) => t.status === "rejected").length}</h3>
          <ul className="mt-2 grid max-h-96 gap-2 overflow-auto">
            {sel.tasks.map((t) => (
              <li key={t.id} className="rounded border border-ink/10 p-3 text-xs">
                <div className="flex justify-between text-ink/60"><span>{t.type} · {t.channel} · {t.status}{t.quality ? ` · judge ${t.quality.score}` : ""}</span><span>{t.createdAt.slice(0, 16).replace("T", " ")}</span></div>
                <p className="mt-1 whitespace-pre-wrap" dir="auto">{(t.editedBody ?? t.body).slice(0, 600)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
