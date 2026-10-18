"use client";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
// Type only: integration-status.ts is server code (it imports model.ts); the type is erased from the bundle (rule 249).
import type { IntegrationView } from "@/lib/integration-status";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";

const S = {
  en: {
    title: "Integrations",
    note: "Each service and whether it is set up, decided only by whether its environment variable names exist on the server. No value is read out or sent to this page. Read-only: change a variable in the host (hPanel) and redeploy.",
    loading: "Loading…", failed: "Could not load the list.",
    status: { on: "On", partial: "Incomplete", off: "Off" },
    required: "needed", optional: "optional", set: "set", missing: "missing", gatedOff: "Off in code", gatedOn: "Code switch",
    callback: "Callback path to list in the platform app (after this site's address)",
    summary: (on: number, all: number) => `${on} of ${all} on`,
  },
  ar: {
    title: "التكاملات",
    note: "كل خدمة وهل هي مُعدّة، ويُحكم بذلك فقط من وجود أسماء متغيرات البيئة على الخادم. لا تُقرأ أي قيمة ولا تُرسل إلى هذه الصفحة. للاطلاع فقط: غيّر المتغير في الاستضافة (hPanel) ثم أعد النشر.",
    loading: "جارٍ التحميل…", failed: "تعذّر تحميل القائمة.",
    status: { on: "تعمل", partial: "ناقصة", off: "متوقفة" },
    required: "مطلوب", optional: "اختياري", set: "مضبوط", missing: "غير مضبوط", gatedOff: "متوقفة في الكود", gatedOn: "مفتاح في الكود",
    callback: "مسار الرجوع الذي يُضاف في تطبيق المنصة (بعد عنوان هذا الموقع)",
    summary: (on: number, all: number) => `${on} من ${all} تعمل`,
  },
} as const;

const TONE: Record<IntegrationView["status"], BadgeTone> = { on: "success", partial: "warning", off: "neutral" };

/** Founder console, Integrations (rule 1540): GET /api/admin/integrations, names and booleans only. */
export default function IntegrationsPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [items, setItems] = useState<IntegrationView[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    adminFetch("/api/admin/integrations").then((r) => r.json()).then((j) => (j.ok ? setItems(j.items) : setError(true))).catch(() => setError(true));
  }, []);
  if (error) return <Callout tone="danger">{L.failed}</Callout>;
  if (!items) return <PanelSkeleton label={L.loading} shape="rows" />;
  const on = items.filter((i) => i.status === "on").length;
  return (
    <div className="grid gap-4" data-testid="integrations-panel">
      <div>
        <h1 className="font-display text-2xl font-bold">{L.title}</h1>
        <p className="mt-1 text-sm text-foreground-muted">{L.note}</p>
        <p className="tnum mt-1 text-sm font-semibold">{L.summary(on, items.length)}</p>
      </div>
      <ul className="grid gap-3 lg:grid-cols-2">
        {items.map((i) => (
          <li key={i.id} className="card card-sm" data-testid={`integration-${i.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{i.name[lang]}</h2>
                <p className="text-xs text-foreground-muted">{i.what[lang]}</p>
              </div>
              <Badge tone={TONE[i.status]} className="shrink-0">{L.status[i.status]}</Badge>
            </div>
            <ul className="mt-2 grid gap-1 text-xs">
              {i.names.map((n) => (
                <li key={n.name} className="flex items-center justify-between gap-2 rounded-md bg-background-muted px-2 py-1">
                  <span className="font-mono break-all" dir="ltr">{n.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-foreground-muted">{n.required ? L.required : L.optional}</span>
                    <Badge tone={n.set ? "success" : n.required ? "danger" : "neutral"}>{n.set ? L.set : L.missing}</Badge>
                  </span>
                </li>
              ))}
            </ul>
            {i.callbacks.length > 0 && (
              <div className="mt-2 text-xs" data-testid={`integration-${i.id}-callbacks`}>
                <p className="text-foreground-muted">{L.callback}</p>
                {i.callbacks.map((c) => <p key={c} className="font-mono break-all" dir="ltr">{c}</p>)}
              </div>
            )}
            {i.gates.map((g) => (
              <p key={g.id} className="mt-2 flex items-start gap-2 text-xs text-foreground-muted"><Badge tone={g.off ? "warning" : "neutral"} className="shrink-0">{g.off ? L.gatedOff : L.gatedOn}</Badge><span>{g.label[lang]}</span></p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
