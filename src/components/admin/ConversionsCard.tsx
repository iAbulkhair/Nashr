"use client";
import { useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { inputError } from "@/lib/admin-input";
import { useAdminForm } from "./AdminForm";
import Badge from "@/components/ui/Badge";

/** The one-time data fills the card offers (rule 4106); the same names as src/lib/conversions/console.ts, client-safe. */
const ROWS = [
  { name: "account-ids", code: "R1", applies: true },
  { name: "multi-org-index", code: "S1", applies: false },
] as const;
type Name = (typeof ROWS)[number]["name"];

/**
 * The card's words (rule 4106), written for the founder, not for an engineer: no internal code as a label (the R1/S1
 * code is shown small beside the title), the same keys in both languages, Western digits in both.
 */
export const CONVERSIONS_COPY = {
  en: {
    title: "One-time data fills",
    what: "The system now knows each person and each workspace by a fixed number, not by their email. Like a national id next to a phone number: a changed email keeps its data, and one person can belong to several workspaces with one login. These fills give accounts made before the numbers existed their numbers. Each runs once and shows counts only, never an email.",
    rows: {
      "account-ids": { title: "Account numbers", what: "Gives each older account its fixed number and links each sign-in email to its owner. One run covers every account." },
      "multi-org-index": { title: "Workspace lists", what: "Records which workspaces each person belongs to, so one login reaches all of them. Applied on 2026-10-23; the check here only confirms nothing is missing." },
    },
    dryRun: "Check (changes nothing)", apply: "Apply", running: "Running…",
    clean: "No problems found", notClean: "Problems found: do not apply, contact engineering",
    applyHint: "First press Check: it counts what is missing and changes nothing. If every line marked “must be 0” shows 0, Apply opens. If conflicts appear, stop and contact support or engineering.",
    again: "When every “to fill” line shows 0, it is done: nothing is left to fill, and running it again changes nothing.",
    dryOnly: "Check only: this one cannot be applied from here.",
    applied: "Applied.", dry: "Check only: nothing was changed.",
    applyTitle: "Give older accounts their numbers?",
    applyMessage: "Writes the missing numbers and sign-in links the check found. It changes no existing data, and a second run writes nothing. The reason is a short note kept in the audit log, so anyone reviewing later knows why this ran.",
    reasonPlaceholder: "Example: numbering the older accounts after workspaces went live",
    took: (ms: number) => `Took ${(ms / 1000).toFixed(1)} s.`,
    counts: {
      accounts: "Accounts checked", missing: "Half-deleted accounts (left as they are)", members: "Team members", owners: "Account owners",
      idsSet: "Account numbers to fill", indexesSet: "Sign-in links to fill", conflicts: "Conflicts (must be 0)", orphans: "Broken team entries (must be 0)",
      personsSet: "People to fill", membershipsSet: "Memberships to fill", orgsSet: "Workspace lists to fill", loginsSet: "Sign-in links to fill",
      paused: "Paused members (stay paused)", personConflicts: "Person conflicts (must be 0)", loginConflicts: "Sign-in conflicts (must be 0)",
      ownerConflicts: "Owner conflicts (must be 0)", orphanRecords: "Members whose account is gone (must be 0)", orphanEntries: "Broken team entries (must be 0)",
      busy: "Busy: run the check again",
    } as Record<string, string>,
    errors: {
      forbidden: "Only a console owner can run this.", read_only: "Only a console owner can run this.",
      busy: "Another fill is running. Wait a minute, then try again.", dry_run_first: "Press Check first and make sure it finds no problems; it stays valid for 15 minutes.",
      dry_run_only: "This one is check only.", slow_down: "Too many runs this hour. Try again later.",
      failed: "The run stopped. Run it again to finish what is left; nothing is written twice.",
    } as Record<string, string>,
    unknownError: "The run did not finish. Try again.",
  },
  ar: {
    title: "تعبئة البيانات لمرة واحدة",
    what: "النظام صار يعرف كل شخص وكل مساحة عمل برقم ثابت، لا بالبريد. مثل رقم الهوية بجانب رقم الجوال: لو تغيّر البريد تبقى البيانات، والشخص الواحد ينتمي لأكثر من مساحة عمل بدخول واحد. هذه التعبئة تعطي الحسابات التي أُنشئت قبل الأرقام أرقامها. كل واحدة تشتغل مرة واحدة، وتعرض أعدادًا فقط بدون أي بريد.",
    rows: {
      "account-ids": { title: "أرقام الحسابات", what: "يعطي كل حساب قديم رقمه الثابت، ويربط كل بريد دخول بصاحبه. تشغيل واحد يكفي لكل الحسابات." },
      "multi-org-index": { title: "قوائم مساحات العمل", what: "يسجّل لكل شخص مساحات العمل التي ينتمي لها، ليدخلها كلها بدخول واحد. طُبّق في 2026-10-23، والفحص هنا يتأكد فقط أن لا شيء ناقص." },
    },
    dryRun: "فحص (بدون تغيير)", apply: "تطبيق", running: "جارٍ التشغيل…",
    clean: "لا توجد مشاكل", notClean: "توجد مشاكل: لا تطبّق، وتواصل مع فريق التطوير",
    applyHint: "اضغط «فحص» أولًا: يعدّ الناقص ولا يغيّر شيئًا. إذا ظهر 0 في كل سطر مكتوب عليه «يجب أن يكون 0» يفتح زر «تطبيق». إذا ظهرت تعارضات فتوقف وتواصل مع الدعم أو فريق التطوير.",
    again: "إذا ظهر 0 في كل سطر «للتعبئة» فالعمل انتهى: لا شيء باقٍ للتعبئة، والتشغيل مرة ثانية لا يغيّر شيئًا.",
    dryOnly: "فحص فقط: هذه لا تُطبّق من هنا.",
    applied: "تم التطبيق.", dry: "فحص فقط: لم يتغيّر شيء.",
    applyTitle: "إعطاء الحسابات القديمة أرقامها؟",
    applyMessage: "يكتب الأرقام وروابط الدخول الناقصة التي وجدها الفحص. لا يغيّر أي بيانات موجودة، والتشغيل الثاني لا يكتب شيئًا. «السبب» ملاحظة قصيرة تُحفظ في سجل التدقيق، ليعرف من يراجع لاحقًا لماذا شُغّل.",
    reasonPlaceholder: "مثال: إعطاء الحسابات القديمة أرقامها بعد تشغيل مساحات العمل",
    took: (ms: number) => `استغرق ${(ms / 1000).toFixed(1)} ث.`,
    counts: {
      accounts: "الحسابات التي فُحصت", missing: "حسابات حُذفت جزئيًا (تُترك كما هي)", members: "أعضاء الفرق", owners: "أصحاب الحسابات",
      idsSet: "أرقام حسابات للتعبئة", indexesSet: "روابط دخول للتعبئة", conflicts: "تعارضات (يجب أن يكون 0)", orphans: "مدخلات فريق معطوبة (يجب أن يكون 0)",
      personsSet: "أشخاص للتعبئة", membershipsSet: "عضويات للتعبئة", orgsSet: "قوائم مساحات للتعبئة", loginsSet: "روابط دخول للتعبئة",
      paused: "أعضاء موقوفون (يبقون موقوفين)", personConflicts: "تعارضات أشخاص (يجب أن يكون 0)", loginConflicts: "تعارضات دخول (يجب أن يكون 0)",
      ownerConflicts: "تعارضات أصحاب الحسابات (يجب أن يكون 0)", orphanRecords: "أعضاء حسابهم محذوف (يجب أن يكون 0)", orphanEntries: "مدخلات فريق معطوبة (يجب أن يكون 0)",
      busy: "مشغول: أعد الفحص",
    } as Record<string, string>,
    errors: {
      forbidden: "فقط مالك لوحة التحكم يقدر يشغّل هذا.", read_only: "فقط مالك لوحة التحكم يقدر يشغّل هذا.",
      busy: "فيه تعبئة ثانية شغالة. انتظر دقيقة ثم حاول مرة ثانية.", dry_run_first: "اضغط «فحص» أولًا وتأكد أنه بلا مشاكل؛ يبقى صالحًا 15 دقيقة.",
      dry_run_only: "هذه فحص فقط.", slow_down: "تشغيلات كثيرة هذه الساعة. حاول لاحقًا.",
      failed: "توقف التشغيل. شغّله مرة ثانية ليكمل ما بقي؛ لا شيء يُكتب مرتين.",
    } as Record<string, string>,
    unknownError: "ما اكتمل التشغيل. حاول مرة ثانية.",
  },
} as const;

type Result = { report: Record<string, number | boolean>; clean: boolean; ms: number; applied: boolean };

/**
 * One fill's row (rule 4106): "Dry run" posts `{apply: false}`; "Apply" (account ids only) opens the console's reason
 * form and posts `{apply: true, reason}` through `adminFetch`, which asks the second factor when the server wants it. Apply
 * is enabled only after a dry run in this view came back clean (0 conflicts, 0 orphans) and no apply has run since; the
 * server checks the same thing again (rule 4104). `initial` renders a result without a server (tests).
 */
export function ConversionRow({ lang, name, applies, initial }: { lang: "ar" | "en"; name: Name; applies: boolean; initial?: Result }) {
  const C = CONVERSIONS_COPY[lang];
  const R = C.rows[name];
  const code = ROWS.find((r) => r.name === name)?.code;
  const [result, setResult] = useState<Result | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [askForm, formDialog] = useAdminForm(lang);
  const canApply = applies && !busy && !!result && !result.applied && result.clean;

  async function go(apply: boolean) {
    setMsg("");
    let reason: string | undefined;
    if (apply) {
      const v = await askForm({ title: C.applyTitle, message: C.applyMessage, submitLabel: C.apply, reasonPlaceholder: C.reasonPlaceholder, fields: [], parse: () => ({ ok: true, value: {} }) });
      if (!v) return;
      reason = v.reason;
    }
    setBusy(true);
    try {
      const r = await adminFetch(`/api/admin/conversions/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(apply ? { apply: true, reason } : { apply: false }) });
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.report && typeof j.report === "object") setResult({ report: j.report, clean: j.clean === true, ms: typeof j.ms === "number" ? j.ms : 0, applied: apply });
      else if (typeof j.error === "string" && j.error.startsWith("reason_")) setMsg(inputError(lang, j.error));
      else setMsg((typeof j.error === "string" && C.errors[j.error]) || C.unknownError);
    } catch {
      setMsg(C.unknownError);
    } finally {
      setBusy(false);
    }
  }

  const counts = result ? Object.entries(result.report).filter(([k, v]) => k !== "apply" && typeof v === "number") : [];
  return (
    <div className="border-t border-border pt-3" data-testid={`conversion-${name}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{R.title}{code && <span className="ms-1.5 text-xs font-normal text-foreground-muted" dir="ltr">{code}</span>}</h3>
          <p className="text-xs text-foreground-muted">{R.what}</p>
        </div>
        {result && <Badge tone={result.clean ? "success" : "warning"} className="shrink-0">{result.clean ? C.clean : C.notClean}</Badge>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void go(false)} className="btn btn-sm">{busy ? C.running : C.dryRun}</button>
        {applies && <button type="button" disabled={!canApply} aria-describedby={`conversion-${name}-hint`} onClick={() => void go(true)} className="btn btn-sm btn-primary">{C.apply}</button>}
      </div>
      <p id={`conversion-${name}-hint`} className="mt-1 text-xs text-foreground-muted">{applies ? `${C.applyHint} ${C.again}` : C.dryOnly}</p>
      {result && (
        <div role="status" className="mt-2 text-xs">
          <p>{result.applied ? C.applied : C.dry} <span className="tnum">{C.took(result.ms)}</span></p>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {counts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2"><dt className="text-foreground-muted">{C.counts[k] ?? k}</dt><dd className="tnum">{String(v)}</dd></div>
            ))}
          </dl>
        </div>
      )}
      {msg && <p role="alert" className="mt-2 text-xs text-danger">{msg}</p>}
      {formDialog}
    </div>
  );
}

/** The console card (rule 4106) on the Integrations page: one row per fill. */
export default function ConversionsCard({ lang }: { lang: "ar" | "en" }) {
  const C = CONVERSIONS_COPY[lang];
  return (
    <section className="card card-sm" data-testid="console-conversions" aria-labelledby="console-conversions-title">
      <h2 id="console-conversions-title" className="font-semibold">{C.title}</h2>
      <p className="mb-2 text-xs text-foreground-muted">{C.what}</p>
      <div className="grid gap-3">
        {ROWS.map((r) => <ConversionRow key={r.name} lang={lang} name={r.name} applies={r.applies} />)}
      </div>
    </section>
  );
}
