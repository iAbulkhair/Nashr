"use client";
import { Fragment, useEffect, useState } from "react";

type Check = { name: string; pass: boolean; detail?: string };
type Result = { id: string; agent: string; type: string; brand: string; ok: boolean; error?: string; score: number | null; dims: Record<string, number> | null; notes: string[]; checks: Check[]; items: { channel: string; title: string; body: string }[]; ms: number; delta: number | null; carried?: string; pb?: { skills: string; review: string; industry?: string; code: string } };
type AgentRow = { agent: string; cases: number; score: number | null; delta: number | null; checksRun?: number; failedChecks: number; promptChanged?: boolean | null };
type Run = { id: string; version: number; trigger: string; startedAt: string; finishedAt: string; status: "complete" | "partial"; overall: number | null; usd: number; agents: AgentRow[]; results: Result[]; regressions: string[]; playbooks?: Record<string, string> };
type Hist = { id: string; version: number; trigger: string; startedAt: string; status: string; overall: number | null; usd: number; regressions: number; agents: AgentRow[] };
type Data = { version: number; cases: number; modelKey: boolean; paused?: boolean; hashes?: Record<string, string>; latest: Run | null; history: Hist[] };

const STR = {
  en: { title: "Golden set · weekly", note: "Fixed cases on fictional brands, run through the real pipeline (agent → reviewer → judge) every Saturday 04:00 Riyadh. Scores compare to the previous run of the same version. The judge is an LLM: moves under ±5 are noise. Checks are deterministic code, not the judge.", run: "Run now", running: "Running… up to 5 minutes, keep this tab open", resume: "Finish missing cases", none: "No run yet. The first one happens on Saturday, or run it now.", noKey: "ANTHROPIC_API_KEY is not set here, so the set cannot run.", paused: "Claude is paused in code (src/lib/model.ts), so the set cannot run.", overall: "Overall", cost: "Model cost $", alerts: "Alerts", noAlerts: "No regressions.", agent: "Agent / case", score: "Score", delta: "Δ", checks: "Checks", secs: "Sec", history: "History", partial: "partial", complete: "complete", show: "output", hide: "hide", busy: "Another run is in progress.", failed: "Run failed", carried: "carried from", promptChanged: "prompt changed", promptChangedTip: "This agent's playbook, review.md, persona and rules, task spec, reviewer checks, judge rubric or industry playbook differs from what the previous run measured the same cases with, so a move in its score may come from the prompt." },
  ar: { title: "المجموعة الذهبية · أسبوعياً", note: "حالات ثابتة على علامات وهمية تمر بخط الإنتاج الحقيقي (الوكيل ← المراجع ← الحَكَم) كل سبت 4:00 فجراً بتوقيت الرياض. الدرجات تُقارن بالتشغيل السابق من نفس الإصدار. الحَكَم نموذج لغوي: أي تغيّر أقل من ±5 ضجيج. الفحوص كود حتمي وليست رأي الحَكَم.", run: "شغّل الآن", running: "قيد التشغيل… حتى 5 دقائق، أبقِ الصفحة مفتوحة", resume: "أكمل الحالات الناقصة", none: "لا يوجد تشغيل بعد. الأول يوم السبت، أو شغّله الآن.", noKey: "ANTHROPIC_API_KEY غير مضبوط هنا، فلا يمكن التشغيل.", paused: "Claude متوقف في الكود (src/lib/model.ts)، فلا يمكن التشغيل.", overall: "المتوسط العام", cost: "تكلفة النماذج $", alerts: "تنبيهات", noAlerts: "لا تراجع.", agent: "الوكيل / الحالة", score: "الدرجة", delta: "Δ", checks: "الفحوص", secs: "ثوانٍ", history: "السجل", partial: "جزئي", complete: "مكتمل", show: "الناتج", hide: "إخفاء", busy: "تشغيل آخر قيد التنفيذ.", failed: "فشل التشغيل", carried: "منقول من تشغيل", promptChanged: "تغيّرت التعليمات", promptChangedTip: "دليل هذا الوكيل أو review.md أو شخصيته وقواعده أو مواصفة المهمة أو فحوص المراجع أو معايير الحَكَم أو دليل القطاع تغيّر عمّا قاس به التشغيل السابق الحالات نفسها، فقد يكون تغيّر الدرجة من التعليمات." },
} as const;

const tone = (n: number | null) => (n === null ? "text-ink/40" : n < 70 ? "text-sadu-deep font-semibold" : "");
const fmtDelta = (d: number | null) => (d === null ? "—" : d > 0 ? `+${d}` : String(d));
const deltaTone = (d: number | null) => (d === null || Math.abs(d) < 5 ? "text-ink/50" : d < 0 ? "text-sadu-deep font-semibold" : "text-oasis font-semibold");

export default function GoldenPanel({ lang = "en" }: { lang?: "ar" | "en" }) {
  const S = STR[lang];
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => fetch("/api/admin/golden").then((r) => r.json()).then((j) => j.ok && setData(j)).catch(() => {});
  useEffect(() => { void load(); }, []);

  async function run(resume = false) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/admin/golden", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) setMsg(j.error === "already_running" ? S.busy : `${S.failed}: ${j.error ?? r.status}`);
    } catch {
      setMsg(S.failed);
    }
    await load();
    setBusy(false);
  }

  const latest = data?.latest ?? null;
  return (
    <section className="card card-sm mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold text-oasis">{S.title}{data ? ` · v${data.version} · ${data.cases}` : ""}</h2>
        <div className="flex gap-2">
          {latest?.status === "partial" && <button type="button" disabled={busy} onClick={() => run(true)} className="btn btn-secondary btn-xs">{S.resume}</button>}
          <button type="button" disabled={busy || data?.modelKey === false || !!data?.paused} onClick={() => run(false)} className="btn btn-primary btn-xs">{busy ? S.running : S.run}</button>
        </div>
      </div>
      <p className="text-xs text-ink/50">{S.note}</p>
      {msg && <p role="alert" className="mt-2 text-sm text-sadu-deep">{msg}</p>}
      {data?.modelKey === false && <p className="mt-2 text-sm text-sadu-deep">{S.noKey}</p>}
      {data?.modelKey !== false && data?.paused && <p className="mt-2 text-sm text-sadu-deep">{S.paused}</p>}
      {data && !latest && <p className="mt-3 text-sm text-ink/60">{S.none}</p>}

      {latest && (
        <>
          <p className="mt-3 text-sm">
            <span className="font-mono tabular-nums">{latest.startedAt.slice(0, 16).replace("T", " ")}</span> · {latest.trigger} · {latest.status === "partial" ? <span className="badge badge-danger">{S.partial}</span> : <span className="badge badge-primary">{S.complete}</span>} · {S.overall}: <span className={`font-mono tabular-nums ${tone(latest.overall)}`}>{latest.overall ?? "—"}</span> · {S.cost}: <span className="font-mono tabular-nums">{latest.usd.toFixed(2)}</span>
          </p>
          <div className="mt-2 rounded-lg bg-salt-dim p-3 text-xs">
            <p className="font-semibold">{S.alerts} ({latest.regressions.length})</p>
            {latest.regressions.length === 0 ? <p className="text-ink/60">{S.noAlerts}</p> : <ul className="mt-1 list-disc ps-5 text-sadu-deep">{latest.regressions.map((r, i) => <li key={i} dir="auto">{r}</li>)}</ul>}
          </div>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full text-sm">
              <thead className="bg-salt-dim text-start text-xs uppercase tracking-wide text-ink/60"><tr><th className="p-2 text-start">{S.agent}</th><th className="text-start">{S.score}</th><th className="text-start">{S.delta}</th><th className="text-start">{S.checks}</th><th className="text-start">{S.secs}</th><th></th></tr></thead>
              <tbody>
                {latest.agents.map((a) => (
                  <Fragment key={a.agent}>
                    <tr className="border-t border-ink/10 bg-salt/60 font-medium">
                      <td className="p-2">{a.agent}{a.promptChanged && <span className="ms-2 badge badge-accent" title={S.promptChangedTip}>{S.promptChanged}</span>}</td><td className={`font-mono tabular-nums ${tone(a.score)}`}>{a.score ?? "—"}</td><td className={`font-mono tabular-nums ${deltaTone(a.delta)}`}><bdi dir="ltr">{fmtDelta(a.delta)}</bdi></td><td className={`font-mono tabular-nums ${a.failedChecks ? "text-sadu-deep" : ""}`}>{a.failedChecks ? `${a.failedChecks} ✗` : a.checksRun ? "✓" : "—"}</td><td></td><td></td>
                    </tr>
                    {latest.results.filter((r) => r.agent === a.agent).map((r) => {
                      const failed = r.checks.filter((c) => !c.pass);
                      return (
                        <Fragment key={r.id}>
                          <tr className="border-t border-ink/5 text-ink/70">
                            <td className="p-2 ps-6 font-mono text-xs">{r.id}{r.carried && <span className="ms-2 badge text-ink/50" dir="auto">{S.carried} <bdi dir="ltr">{r.carried.slice(0, 10)}</bdi></span>}</td>
                            <td className={`font-mono tabular-nums ${tone(r.score)}`}>{r.ok ? r.score ?? "—" : <span className="text-sadu-deep">{r.error}</span>}</td>
                            <td className={`font-mono tabular-nums ${deltaTone(r.delta)}`}><bdi dir="ltr">{fmtDelta(r.delta)}</bdi></td>
                            <td className={`text-xs ${failed.length ? "text-sadu-deep" : ""}`} dir="auto">{r.checks.length === 0 ? "—" : failed.length ? failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join(" · ") : `${r.checks.length}/${r.checks.length} ✓`}</td>
                            <td className="font-mono tabular-nums">{Math.round(r.ms / 1000)}</td>
                            <td>{r.items.length > 0 && <button type="button" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)} className="btn btn-secondary btn-xs">{openId === r.id ? S.hide : S.show}</button>}</td>
                          </tr>
                          {openId === r.id && (
                            <tr><td colSpan={6} className="bg-white p-3">
                              {r.dims && <p className="font-mono text-xs text-ink/60">{Object.entries(r.dims).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>}
                              {r.notes.length > 0 && <p className="mt-1 text-xs text-ink/70" dir="auto">{r.notes.join(" · ")}</p>}
                              {r.items.map((it, i) => <pre key={i} dir="auto" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-ink/10 p-2 text-xs"><b>{it.channel} · {it.title}</b>{"\n"}{it.body}</pre>)}
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data && data.history.length > 1 && (
        <p className="mt-3 text-xs text-ink/60">{S.history}: {data.history.map((h) => `${h.startedAt.slice(0, 10)} v${h.version} ${h.overall ?? "—"}${h.status === "partial" ? "*" : ""} ($${h.usd.toFixed(2)})`).join(" · ")}</p>
      )}
    </section>
  );
}
