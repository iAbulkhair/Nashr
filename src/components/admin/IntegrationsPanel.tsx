"use client";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
// Type only: integration-status.ts is server code (it imports model.ts); the type is erased from the bundle (rule 249).
import type { IntegrationView } from "@/lib/integration-status";
import type { ComplianceSummary } from "@/lib/connectors/shopify-compliance";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { Time } from "@/components/ui/Time";

const S = {
  en: {
    title: "Integrations",
    note: "Each service and whether it is set up, decided only by whether its environment variable names exist on the server. No value is read out or sent to this page. Read-only: change a variable in the host (hPanel) and redeploy.",
    loading: "Loading…", failed: "Could not load the list.",
    status: { on: "On", partial: "Incomplete", off: "Off" },
    required: "needed", optional: "optional", set: "set", missing: "missing", gatedOff: "Off in code", gatedOn: "Code switch",
    callback: "Callback path to list in the platform app (after this site's address)",
    webhook: "Webhook path to give the platform app (after this site's address; Shopify: all three compliance fields)",
    compliance: "Shopify compliance requests",
    pending: (n: number) => `${n} store erasure${n === 1 ? "" : "s"} waiting for the next stores run`,
    none: "None received yet.",
    topic: { "customers/data_request": "Customer data request (nothing held)", "customers/redact": "Customer erasure (nothing held)", "shop/redact": "Store erasure queued", "shop/redact:done": "Store erasure done" } as Record<string, string>,
    workspaces: (n: number) => `${n} workspace${n === 1 ? "" : "s"}`,
    summary: (on: number, all: number) => `${on} of ${all} on`,
    health: "Connections across workspaces",
    healthNote: (n: number) => `Counted by the stores run over ${n} workspace${n === 1 ? "" : "s"}. Numbers only; no workspace is named.`,
    healthNone: "Not counted yet: the stores run writes this.",
    healthCols: { platform: "Platform", connected: "Connected", reconnect: "Must reconnect", composio: "Via Composio" },
  },
  ar: {
    title: "التكاملات",
    note: "كل خدمة وهل هي مُعدّة، ويُحكم بذلك فقط من وجود أسماء متغيرات البيئة على الخادم. لا تُقرأ أي قيمة ولا تُرسل إلى هذه الصفحة. للاطلاع فقط: غيّر المتغير في الاستضافة (hPanel) ثم أعد النشر.",
    loading: "جارٍ التحميل…", failed: "تعذّر تحميل القائمة.",
    status: { on: "تعمل", partial: "ناقصة", off: "متوقفة" },
    required: "مطلوب", optional: "اختياري", set: "مضبوط", missing: "غير مضبوط", gatedOff: "متوقفة في الكود", gatedOn: "مفتاح في الكود",
    callback: "مسار الرجوع الذي يُضاف في تطبيق المنصة (بعد عنوان هذا الموقع)",
    webhook: "مسار الإشعارات (Webhook) الذي يُعطى لتطبيق المنصة (بعد عنوان هذا الموقع؛ في Shopify: حقول الامتثال الثلاثة)",
    compliance: "طلبات الامتثال من Shopify",
    pending: (n: number) => `طلبات حذف متاجر تنتظر تشغيل المتاجر القادم: ${n}`,
    none: "لم يصل أي طلب بعد.",
    topic: { "customers/data_request": "طلب بيانات عميل (لا نحتفظ بشيء)", "customers/redact": "حذف بيانات عميل (لا نحتفظ بشيء)", "shop/redact": "طلب حذف بيانات متجر في الانتظار", "shop/redact:done": "تم حذف بيانات المتجر" } as Record<string, string>,
    workspaces: (n: number) => `مساحات العمل: ${n}`,
    summary: (on: number, all: number) => `${on} من ${all} تعمل`,
    health: "الربط عبر مساحات العمل",
    healthNote: (n: number) => `عدّها تشغيل المتاجر في مساحات العمل: ${n}. أرقام فقط، ولا تُسمّى أي مساحة.`,
    healthNone: "لم تُعدّ بعد: يكتبها تشغيل المتاجر.",
    healthCols: { platform: "المنصة", connected: "مربوطة", reconnect: "تحتاج إعادة ربط", composio: "عبر Composio" },
  },
} as const;

/** GET /api/admin/integrations `connections` (rules 2177-2178): the stores run's last count, numbers and names only. */
type Connections = { at: string; workspaces: number; rows: { id: string; name: string; connected: number; reconnect: number; composio: number }[] };

const TONE: Record<IntegrationView["status"], BadgeTone> = { on: "success", partial: "warning", off: "neutral" };

/** Founder console, Integrations (rule 1540): GET /api/admin/integrations, names and booleans only. */
export default function IntegrationsPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [items, setItems] = useState<IntegrationView[] | null>(null);
  const [shopify, setShopify] = useState<ComplianceSummary | null>(null);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    adminFetch("/api/admin/integrations").then((r) => r.json()).then((j) => {
      if (!j.ok) return setError(true);
      setItems(j.items);
      setShopify(j.shopifyCompliance ?? null);
      setConnections(j.connections ?? null);
    }).catch(() => setError(true));
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
            {i.webhooks.length > 0 && (
              <div className="mt-2 text-xs" data-testid={`integration-${i.id}-webhooks`}>
                <p className="text-foreground-muted">{L.webhook}</p>
                {i.webhooks.map((w) => <p key={w} className="font-mono break-all" dir="ltr">{w}</p>)}
              </div>
            )}
            {i.id === "shopify" && shopify && (
              <div className="mt-2 text-xs" data-testid="integration-shopify-compliance">
                <p className="font-semibold">{L.compliance}</p>
                {shopify.pending.length > 0 && <p className="mt-1"><Badge tone="warning">{L.pending(shopify.pending.length)}</Badge></p>}
                {shopify.recent.length === 0 ? <p className="text-foreground-muted">{L.none}</p> : (
                  <ul className="mt-1 grid gap-0.5">
                    {shopify.recent.map((r, n) => (
                      <li key={n} className="flex flex-wrap gap-x-2">
                        <span>{L.topic[r.topic] ?? r.topic}</span>
                        <span className="font-mono" dir="ltr">{r.shop}</span>
                        <Time value={r.at} lang={lang} style="datetime" className="tnum text-foreground-muted" />
                        {typeof r.workspaces === "number" && <span className="text-foreground-muted">{L.workspaces(r.workspaces)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {i.gates.map((g) => (
              <p key={g.id} className="mt-2 flex items-start gap-2 text-xs text-foreground-muted"><Badge tone={g.off ? "warning" : "neutral"} className="shrink-0">{g.off ? L.gatedOff : L.gatedOn}</Badge><span>{g.label[lang]}</span></p>
            ))}
          </li>
        ))}
      </ul>
      <section className="card card-sm" data-testid="integrations-connections">
        <h2 className="font-semibold">{L.health}</h2>
        {!connections ? <p className="mt-1 text-xs text-foreground-muted">{L.healthNone}</p> : (
          <>
            <p className="mt-1 text-xs text-foreground-muted">
              {L.healthNote(connections.workspaces)} <Time value={connections.at} lang={lang} style="datetime" className="tnum" />
            </p>
            {connections.rows.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-foreground-muted">
                    <th className="py-1 text-start font-normal">{L.healthCols.platform}</th>
                    <th className="py-1 text-end font-normal">{L.healthCols.connected}</th>
                    <th className="py-1 text-end font-normal">{L.healthCols.reconnect}</th>
                    <th className="py-1 text-end font-normal">{L.healthCols.composio}</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.rows.map((r) => (
                    <tr key={r.id} className="border-t border-border" data-testid={`integrations-connections-${r.id}`}>
                      <td className="py-1">{r.name}</td>
                      <td className="tnum py-1 text-end">{r.connected}</td>
                      <td className="tnum py-1 text-end">{r.reconnect > 0 ? <Badge tone="warning">{r.reconnect}</Badge> : 0}</td>
                      <td className="tnum py-1 text-end">{r.composio}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
