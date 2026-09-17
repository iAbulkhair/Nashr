"use client";
import { Fragment, useEffect, useState } from "react";

type U = { email: string; name: string; phone: string; plan: string; credits: number; trialEnds: string; createdAt: string; renewedAt?: string | null; suspended?: boolean; lang?: string; tokens?: number; usd?: number; calls?: number };
type Detail = { user: U; brand: Record<string, unknown> | null; tasks: T[]; usage: { in: number; out: number; calls: number; usd: number; kinds: Record<string, number> }; connections: { provider: string; label?: string; connectedAt?: string }[]; brands: { id: string; name: string; status: string }[]; conversations: number; referrals: number; avgScore: number | null };
type T = { id: string; type: string; channel: string; title: string; status: string; createdAt: string; body: string; editedBody?: string; quality?: { score: number; notes: string } };
type TM = { type: string; n: number; approvalRate: number | null; editRate: number | null; editMagnitude: number | null; published: number; avgScore: number | null; low: number; avgHoursToDecide: number | null };
type AM = { agent: string; n: number; approvalRate: number | null; editRate: number | null; avgScore: number | null; low: number; thumbsUp: number; thumbsDown: number; types: TM[] };

const STR = {
  en: { users: "Users", paying: "Paying", today: "Signed up today", trial: "Trial", cost: "Model cost this month $", tokens: "Tokens this month", calls: "Model calls", suspended: "Suspended", search: "Search email, name, phone, plan…", email: "Email", name: "Name", phone: "Phone", plan: "Plan", credits: "Credits", tokensMo: "Tokens (mo)", costMo: "Cost $ (mo)", trialEnds: "Trial ends", joined: "Joined", addCredits: "+ credits", planNote: "Changing the plan resets the balance to that plan's monthly allowance and starts the renewal cycle (balance resets on the 1st of each month, UTC). Use \"+ credits\" for top-ups within the month. Tokens and cost are this month's real model usage.", quality: "Agent quality · last 30 days · all workspaces", qualityNote: "Approval = approved ÷ decided. Edited = approved items the owner changed (magnitude = % of text changed). Judge = automated score /100 (85+ ready, <70 regenerate). Thumbs = chat replies.", agentType: "Agent / type", items: "Items", approval: "Approval", edited: "Edited", magnitude: "Magnitude", published: "Published", judge: "Judge", low: "<70", hours: "Hours to decide", perWorkspace: "Per workspace", loading: "Loading…", close: "close", impersonate: "Log in as user", extend: "Extend trial", reset: "Reset password", emailsIn: "Emails in", suspend: "Suspend", unsuspend: "Unsuspend", del: "Delete account", usage: "Model usage (month)", trialRenewed: "Trial ends / renewed", integrations: "Integrations", brandsEtc: "Brands · conversations · referrals · judge", brandFile: "Brand file", notCompleted: "— not completed —", generated: "Generated items", approved: "approved", rejected: "rejected", promptCredits: "Credits to add (negative to remove):", promptDays: "Extend trial by days:", promptDelete: "Type the email to permanently delete this account and all its data:", promptTemp: "Temporary password (shown once, send it on WhatsApp):", arabic: "Arabic", english: "English" },
  ar: { users: "المستخدمون", paying: "مشتركون", today: "سجّلوا اليوم", trial: "تجربة", cost: "تكلفة النماذج هذا الشهر $", tokens: "توكنز هذا الشهر", calls: "استدعاءات النماذج", suspended: "موقوفون", search: "ابحث بالبريد أو الاسم أو الجوال أو الخطة…", email: "البريد", name: "الاسم", phone: "الجوال", plan: "الخطة", credits: "الكريدت", tokensMo: "توكنز (الشهر)", costMo: "التكلفة $ (الشهر)", trialEnds: "نهاية التجربة", joined: "انضم", addCredits: "+ كريدت", planNote: "تغيير الخطة يعيد الرصيد إلى مخصص الخطة الشهري ويبدأ دورة التجديد (يتجدد الرصيد في أول كل شهر UTC). استخدم «+ كريدت» للإضافات خلال الشهر. التوكنز والتكلفة هي الاستهلاك الحقيقي للنماذج هذا الشهر.", quality: "جودة الوكلاء · آخر 30 يوماً · كل المساحات", qualityNote: "الاعتماد = معتمد ÷ محسوم. التعديل = عناصر معتمدة غيّرها المالك (الحجم = % النص المتغيّر). الحَكَم = درجة آلية من 100 (85+ جاهز، أقل من 70 أعد التوليد). الإبهام = ردود الدردشة.", agentType: "الوكيل / النوع", items: "عناصر", approval: "اعتماد", edited: "تعديل", magnitude: "الحجم", published: "نُشر", judge: "الحَكَم", low: "<70", hours: "ساعات حتى القرار", perWorkspace: "لكل مساحة", loading: "جارٍ التحميل…", close: "إغلاق", impersonate: "دخول كالمستخدم", extend: "تمديد التجربة", reset: "إعادة تعيين كلمة المرور", emailsIn: "الإيميلات بـ", suspend: "إيقاف", unsuspend: "إلغاء الإيقاف", del: "حذف الحساب", usage: "استهلاك النماذج (الشهر)", trialRenewed: "نهاية التجربة / التجديد", integrations: "التكاملات", brandsEtc: "علامات · محادثات · إحالات · الحَكَم", brandFile: "ملف العلامة", notCompleted: "— غير مكتمل —", generated: "العناصر المولّدة", approved: "معتمد", rejected: "مرفوض", promptCredits: "كريدت للإضافة (سالب للخصم):", promptDays: "تمديد التجربة بالأيام:", promptDelete: "اكتب البريد لحذف الحساب وكل بياناته نهائياً:", promptTemp: "كلمة مرور مؤقتة (تظهر مرة واحدة، أرسلها على واتساب):", arabic: "العربية", english: "الإنجليزية" },
} as const;

export default function AdminConsole({ lang = "en" }: { lang?: "ar" | "en" }) {
  const S = STR[lang];
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
  useEffect(() => { load(); fetch("/api/admin/evals").then((r) => r.json()).then((j) => j.ok && setEvals(j)).catch(() => {}); }, []);

  async function setPlan(email: string, plan: string) {
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, plan }) });
    setMsg(`${email} → ${plan}`);
    await load();
    setBusy(false);
  }
  async function addCredits(email: string) {
    const n = Number(prompt(S.promptCredits, "100"));
    if (!n) return;
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, addCredits: n }) });
    setMsg(`${email} +${n} credits`);
    await load();
    setBusy(false);
  }
  async function open(email: string) {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`);
    const j = await r.json();
    if (j.ok) setSel(j);
  }

  if (users === null) return <p className="text-ink/60">{S.loading}</p>;
  const paying = users.filter((u) => u.plan !== "trial").length;
  const shown = users.filter((u) => !q || [u.email, u.name, u.phone, u.plan].some((x) => (x ?? "").toLowerCase().includes(q.toLowerCase())));
  const today = users.filter((u) => u.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {[[S.users, users.length], [S.paying, paying], [S.today, today], [S.trial, users.length - paying], [S.cost, total ? total.usd.toFixed(2) : "…"], [S.tokens, total ? `${Math.round((total.in + total.out) / 1000)}k` : "…"], [S.calls, total ? total.calls : "…"], [S.suspended, users.filter((u) => u.suspended).length]].map(([l, v]) => (
          <div key={String(l)} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="font-display text-2xl font-bold text-oasis">{v}</p></div>
        ))}
      </div>
      {msg && <p className="text-sm text-oasis">{msg}</p>}
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
      <section className="card card-sm">
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
      <p className="text-xs text-ink/50">{S.planNote}</p>

      {sel && (
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
