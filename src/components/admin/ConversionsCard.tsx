"use client";
import { useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { inputError } from "@/lib/admin-input";
import { useAdminForm } from "./AdminForm";
import Badge from "@/components/ui/Badge";

/** The one-time data fills the card offers (rule 4106); the same names as src/lib/conversions/console.ts, client-safe. */
const ROWS = [
  { name: "account-ids", applies: true },
  { name: "multi-org-index", applies: false },
] as const;
type Name = (typeof ROWS)[number]["name"];

/** The card's words (rule 4106); the same keys in both languages, Western digits in both. */
export const CONVERSIONS_COPY = {
  en: {
    title: "One-time data fills",
    what: "Fills records that accounts from before a release are missing, on the app's own store connection: no terminal and no store keys. Each run reads every account and shows counts only, never an address.",
    rows: {
      "account-ids": { title: "Account ids (R1)", what: "Gives each owner and member record its frozen id, and each sign-in address its login index. Needed before the multi-workspace switch-on." },
      "multi-org-index": { title: "Workspace records (S1)", what: "Already applied on 2026-10-23. A dry run here only checks that nothing is missing; it cannot be applied from the console." },
    },
    dryRun: "Dry run", apply: "Apply", running: "Running…",
    clean: "Clean: nothing left alone", notClean: "Not clean: conflicts or orphans left alone",
    applyHint: "Apply opens after a dry run in this view finds 0 conflicts and 0 orphans.",
    again: "Running it a second time writes nothing: it only fills what is still missing.",
    dryOnly: "Dry run only.",
    applied: "Applied.", dry: "Dry run (nothing written).",
    applyTitle: "Apply the account-id fill?",
    applyMessage: "Writes the missing ids and login indexes found by the dry run. It never overwrites a record, and a second run writes nothing.",
    took: (ms: number) => `Took ${(ms / 1000).toFixed(1)} s.`,
    counts: {
      accounts: "Accounts", missing: "Missing records", members: "Members", owners: "Owners", idsSet: "Ids to set", indexesSet: "Login indexes to set",
      conflicts: "Conflicts", orphans: "Orphans", personsSet: "Persons to set", membershipsSet: "Memberships to set", orgsSet: "Workspace entries to set",
      loginsSet: "Login indexes to set", paused: "Paused seats", personConflicts: "Person conflicts", loginConflicts: "Login conflicts",
      ownerConflicts: "Owner conflicts", orphanRecords: "Orphan member records", orphanEntries: "Orphan roster entries", busy: "Busy (run again)",
    } as Record<string, string>,
    errors: {
      forbidden: "Only a console owner can run this.", read_only: "Only a console owner can run this.",
      busy: "Another fill is running. Wait a minute, then try again.", dry_run_first: "Run a clean dry run first; it counts for 15 minutes.",
      dry_run_only: "This fill runs as a dry run only.", slow_down: "Too many runs this hour. Try again later.",
      failed: "The run stopped. Nothing is half-written that a second run does not finish.",
    } as Record<string, string>,
    unknownError: "The run did not finish. Try again.",
  },
  ar: {
    title: "تعبئة البيانات لمرة واحدة",
    what: "تعبّي السجلات الناقصة في الحسابات القديمة من قبل الإصدار، عبر اتصال التطبيق نفسه بقاعدة البيانات: بدون طرفية وبدون مفاتيح. كل تشغيل يقرأ كل الحسابات ويعرض أعدادًا فقط، بدون أي عنوان بريد.",
    rows: {
      "account-ids": { title: "معرّفات الحسابات (R1)", what: "يعطي كل سجل مالك وعضو معرّفه الثابت، وكل عنوان دخول فهرسه. مطلوب قبل تشغيل تعدد مساحات العمل." },
      "multi-org-index": { title: "سجلات مساحات العمل (S1)", what: "طُبّق في 2026-10-23. التشغيل التجريبي هنا يتأكد فقط أن لا شيء ناقص، ولا يمكن تطبيقه من لوحة التحكم." },
    },
    dryRun: "تشغيل تجريبي", apply: "تطبيق", running: "جارٍ التشغيل…",
    clean: "نظيف: لا شيء متروك", notClean: "غير نظيف: فيه تعارضات أو سجلات يتيمة متروكة كما هي",
    applyHint: "زر التطبيق يفتح بعد تشغيل تجريبي في هذه الصفحة يجد 0 تعارضات و0 سجلات يتيمة.",
    again: "التشغيل مرة ثانية لا يكتب شيئًا: يعبّي فقط ما زال ناقصًا.",
    dryOnly: "تشغيل تجريبي فقط.",
    applied: "تم التطبيق.", dry: "تشغيل تجريبي (لم يُكتب شيء).",
    applyTitle: "تطبيق تعبئة معرّفات الحسابات؟",
    applyMessage: "يكتب المعرّفات وفهارس الدخول الناقصة التي وجدها التشغيل التجريبي. لا يكتب فوق أي سجل، والتشغيل الثاني لا يكتب شيئًا.",
    took: (ms: number) => `استغرق ${(ms / 1000).toFixed(1)} ث.`,
    counts: {
      accounts: "الحسابات", missing: "سجلات مفقودة", members: "الأعضاء", owners: "الملاك", idsSet: "معرّفات للتعبئة", indexesSet: "فهارس دخول للتعبئة",
      conflicts: "تعارضات", orphans: "سجلات يتيمة", personsSet: "أشخاص للتعبئة", membershipsSet: "عضويات للتعبئة", orgsSet: "مدخلات مساحات للتعبئة",
      loginsSet: "فهارس دخول للتعبئة", paused: "مقاعد موقوفة", personConflicts: "تعارضات أشخاص", loginConflicts: "تعارضات دخول",
      ownerConflicts: "تعارضات ملاك", orphanRecords: "سجلات أعضاء يتيمة", orphanEntries: "مدخلات قائمة يتيمة", busy: "مشغول (أعد التشغيل)",
    } as Record<string, string>,
    errors: {
      forbidden: "فقط مالك لوحة التحكم يقدر يشغّل هذا.", read_only: "فقط مالك لوحة التحكم يقدر يشغّل هذا.",
      busy: "فيه تعبئة ثانية شغالة. انتظر دقيقة ثم حاول مرة ثانية.", dry_run_first: "شغّل تشغيلًا تجريبيًا نظيفًا أولًا؛ يبقى صالحًا 15 دقيقة.",
      dry_run_only: "هذه التعبئة تشغيل تجريبي فقط.", slow_down: "تشغيلات كثيرة هذه الساعة. حاول لاحقًا.",
      failed: "توقف التشغيل. لا شيء مكتوب نصفه إلا ويكمله التشغيل الثاني.",
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
  const [result, setResult] = useState<Result | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [askForm, formDialog] = useAdminForm(lang);
  const canApply = applies && !busy && !!result && !result.applied && result.clean;

  async function go(apply: boolean) {
    setMsg("");
    let reason: string | undefined;
    if (apply) {
      const v = await askForm({ title: C.applyTitle, message: C.applyMessage, submitLabel: C.apply, fields: [], parse: () => ({ ok: true, value: {} }) });
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
          <h3 className="text-sm font-semibold">{R.title}</h3>
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
