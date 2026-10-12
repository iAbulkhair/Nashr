"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { useConfirm } from "../app/ConfirmDialog";
// Types only: agent-scope.ts and agent-scope-eval.ts are server code (Redis, the classifier); the types are erased from the bundle.
import type { AgentScopeLogEntry, AgentScopeModes } from "@/lib/agent-scope";
import type { AgentScopeEval } from "@/lib/agent-scope-eval";

type Data = { day: string; modes: AgentScopeModes; eval: AgentScopeEval | null; log: AgentScopeLogEntry[]; cost: { month: string; calls: number; usd: number } };

const STR = {
  en: {
    title: "Agent scope",
    note: "Each layer is off, shadow (logs what it would refuse, changes nothing) or enforce (refuses). Input and output go to enforce only after a passed test set on the current model, and only after two weeks of shadow.",
    prompt: "Scope paragraph", input: "Owner requests", role: "Roles", output: "Replies, items and publishing",
    evalTitle: "Test set", noEval: "Not run yet.", run: "Run the test set", running: "Running…",
    confirm: "This sends about 200 short checks to the paid model, on Thakeen's meter. Run it now?", cancel: "Cancel",
    recall: "Refusals caught", wrong: "Wrong refusals", errors: "No answer", passed: "Passed", failed: "Not passed", model: "Model",
    cost: (calls: number, usd: number, month: string) => `${month}: ${calls} checks, $${usd.toFixed(2)}`,
    day: "Day", empty: "No lines on this day.", release: "Release", released: "Released: the owner can publish this text now.",
    cols: ["Time", "Account", "Brand", "Agent", "Layer", "Where", "Verdict", "Mode", "Text", ""],
    errs: { eval_not_passed: "Enforce needs a passed test set on the current model.", model_paused: "The model is paused.", already_running: "A run is already going.", bad_mode: "Unknown value." } as Record<string, string>,
    fail: "Failed",
  },
  ar: {
    title: "نطاق الفريق",
    note: "كل طبقة إما متوقفة، أو مراقبة (تسجل ما كانت سترفضه ولا تغيّر شيئاً)، أو مفعّلة (ترفض). طلبات المالك والمخرجات لا تُفعَّل إلا بعد نجاح مجموعة الاختبار على النموذج الحالي، وبعد أسبوعين من المراقبة.",
    prompt: "فقرة النطاق", input: "طلبات المالك", role: "الأدوار", output: "الردود والعناصر والنشر",
    evalTitle: "مجموعة الاختبار", noEval: "لم تُشغَّل بعد.", run: "شغّل مجموعة الاختبار", running: "جارٍ التشغيل…",
    confirm: "سيرسل هذا نحو 200 فحص قصير إلى النموذج المدفوع، على حساب ذكين. تشغيل الآن؟", cancel: "إلغاء",
    recall: "الرفض الصحيح", wrong: "رفض خاطئ", errors: "بلا إجابة", passed: "ناجحة", failed: "غير ناجحة", model: "النموذج",
    cost: (calls: number, usd: number, month: string) => `${month}: ${calls} فحص، ${usd.toFixed(2)}$`,
    day: "اليوم", empty: "لا سطور في هذا اليوم.", release: "إفراج", released: "تم الإفراج: يستطيع المالك نشر هذا النص الآن.",
    cols: ["الوقت", "الحساب", "العلامة", "الموظف", "الطبقة", "المكان", "النتيجة", "الوضع", "النص", ""],
    errs: { eval_not_passed: "التفعيل يحتاج نجاح مجموعة الاختبار على النموذج الحالي.", model_paused: "النموذج متوقف.", already_running: "يوجد تشغيل جارٍ.", bad_mode: "قيمة غير معروفة." } as Record<string, string>,
    fail: "تعذّر",
  },
} as const;

const OPTIONS: Record<keyof AgentScopeModes, readonly string[]> = { prompt: ["on", "off"], input: ["off", "shadow", "enforce"], role: ["off", "shadow", "enforce"], output: ["off", "shadow", "enforce"] };
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** Founder console, Quality: the agent-scope switches, the test set, the classifier's cost and the day's log (rules 1412, 1413). */
export default function AgentScopePanel({ lang = "en" }: { lang?: "ar" | "en" }) {
  const S = STR[lang];
  const [day, setDay] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // The console's own dialog, not the browser's confirm (rule 1182).
  const [ask, confirmDialog] = useConfirm();

  const load = useCallback((d: string) => adminFetch(`/api/admin/agent-scope${d ? `?day=${encodeURIComponent(d)}` : ""}`).then((r) => r.json()).then((j) => j.ok && setData(j)).catch(() => {}), []);
  useEffect(() => { void load(day); }, [day, load]);

  async function post(path: string, body: unknown, done?: string) {
    setBusy(true); setMsg("");
    try {
      const r = await adminFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      setMsg(j.ok ? done ?? "" : S.errs[j.error] ?? `${S.fail}: ${j.error ?? r.status}`);
    } catch {
      setMsg(S.fail);
    }
    await load(day);
    setBusy(false);
  }

  const ev = data?.eval ?? null;
  return (
    <section className="card card-sm mt-6">
      <h2 className="font-display text-lg font-semibold text-foreground">{S.title}</h2>
      <p className="text-xs text-foreground-muted">{S.note}</p>
      {msg && <p role="status" className="mt-2 text-sm text-foreground">{msg}</p>}
      {data && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(Object.keys(OPTIONS) as (keyof AgentScopeModes)[]).map((k) => (
              <label key={k} className="grid gap-1 text-xs text-foreground-muted">
                {S[k]}
                <select disabled={busy} value={data.modes[k]} onChange={(e) => post("/api/admin/agent-scope/modes", { [k]: e.target.value })} className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground">
                  {OPTIONS[k].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">{S.evalTitle}</h3>
            <button type="button" disabled={busy} onClick={async () => { if (await ask({ title: S.run, message: S.confirm, confirmLabel: S.run, cancelLabel: S.cancel })) void post("/api/admin/agent-scope/eval", {}); }} className="btn btn-primary btn-xs">{busy ? S.running : S.run}</button>
          </div>
          {!ev ? <p className="text-sm text-foreground-muted">{S.noEval}</p> : (
            <p className="text-sm">
              <span className={ev.passed ? "font-semibold text-foreground" : "font-semibold text-danger"}>{ev.passed ? S.passed : S.failed}</span>
              {` · ${S.recall} ${pct(ev.recall)} · ${S.wrong} ${pct(ev.wrongRefusals)} · ${S.errors} ${ev.errors}/${ev.total} · ${S.model} `}<span className="font-mono">{ev.model}</span>{` · ${ev.at.slice(0, 16).replace("T", " ")}`}
            </p>
          )}
          <p className="mt-1 text-xs text-foreground-muted">{S.cost(data.cost.calls, data.cost.usd, data.cost.month)}</p>

          <label className="mt-4 flex items-center gap-2 text-xs text-foreground-muted">
            {S.day}
            <input type="date" value={day || data.day} onChange={(e) => setDay(e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-sm text-foreground" />
          </label>
          {data.log.length === 0 ? <p className="mt-2 text-sm text-foreground-muted">{S.empty}</p> : (
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs">
              <thead className="bg-background-muted text-left uppercase tracking-wide text-foreground-muted"><tr>{S.cols.map((c, i) => <th key={i} className="p-2">{c}</th>)}</tr></thead>
              <tbody>
                {data.log.map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-t border-foreground/10 align-top">
                    <td className="p-2 font-mono">{e.at.slice(11, 19)}</td><td>{e.email}</td><td className="font-mono">{e.brandId}</td><td>{e.agent}</td><td>{e.layer}</td><td>{e.where}</td>
                    <td className={e.verdict === "in" ? "" : "text-danger"}>{e.verdict}{e.error ? ` (${e.error})` : ""}</td><td>{e.mode}</td>
                    <td className="max-w-xs"><bdi dir="auto">{e.text}</bdi></td>
                    <td>{(e.where === "publish" || e.where === "chat_publish") && e.itemId && (
                      <button type="button" disabled={busy} onClick={() => post("/api/admin/agent-scope/release", { email: e.email, brandId: e.brandId, itemId: e.itemId }, S.released)} className="btn btn-secondary btn-xs">{S.release}</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
      {confirmDialog}
    </section>
  );
}
