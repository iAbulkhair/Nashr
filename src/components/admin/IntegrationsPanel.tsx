"use client";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { inputError } from "@/lib/admin-input";
import { useAdminForm } from "./AdminForm";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
// Type only: integration-status.ts is server code (it imports model.ts); the type is erased from the bundle (rule 249).
import type { IntegrationView } from "@/lib/integration-status";
import type { ComplianceSummary } from "@/lib/connectors/shopify-compliance";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";
import ConversionsCard from "./ConversionsCard";
import { Time } from "@/components/ui/Time";

const S = {
  en: {
    title: "Integrations",
    note: "Each service and whether it is set up, decided only by whether its environment variable names exist on the server. No value is read out or sent to this page. The service list is read-only: change a variable in the host (hPanel) and redeploy. The Passkeys row below is a runtime switch a console owner can change here.",
    loading: "Loading…", failed: "Could not load the list.",
    status: { on: "On", partial: "Incomplete", off: "Off" },
    required: "needed", optional: "optional", set: "set", missing: "missing", gatedOff: "Off in code", gatedOn: "Code switch",
    callback: "Callback path to list in the platform app (after this site's address)",
    webhook: "Webhook path to give the platform app (after this site's address; Shopify: all three compliance fields)",
    compliance: "Shopify compliance requests",
    pending: (n: number) => `${n} store erasure${n === 1 ? "" : "s"} waiting for the next stores run`,
    none: "None received yet.",
    topic: { "customers/data_request": "Customer data request (nothing held)", "customers/redact": "Customer erasure (nothing held)", "shop/redact": "Store erasure queued", "app/uninstalled": "Store uninstalled the app: removal queued", "shop/redact:done": "Store erasure done" } as Record<string, string>,
    workspaces: (n: number) => `${n} workspace${n === 1 ? "" : "s"}`,
    summary: (on: number, all: number) => `${on} of ${all} on`,
    health: "Connections across workspaces",
    healthNote: (n: number) => `Counted by the stores run over ${n} workspace${n === 1 ? "" : "s"}. Numbers only; no workspace is named.`,
    healthNone: "Not counted yet: the stores run writes this.",
    healthCols: { platform: "Platform", connected: "Connected", reconnect: "Must reconnect", composio: "Via Composio" },
    keepAlive: (k: KeepAlive) => `Token keep-alive: ${k.due} expired, ${k.refreshed} refreshed, ${k.lost} refused, ${k.failed} failed.`,
    keepAliveNone: "Token keep-alive: not recorded for this run.",
    hooks: (h: Hooks) => `Shopify uninstall webhook: ${h.due} stores without it, ${h.subscribed} subscribed, ${h.failed} failed.`,
    hooksNone: "Shopify uninstall webhook: not recorded for this run.",
  },
  ar: {
    title: "التكاملات",
    note: "كل خدمة وهل هي مُعدّة، ويُحكم بذلك فقط من وجود أسماء متغيرات البيئة على الخادم. لا تُقرأ أي قيمة ولا تُرسل إلى هذه الصفحة. قائمة الخدمات للاطلاع فقط: غيّر المتغير في الاستضافة (hPanel) ثم أعد النشر. صف «مفاتيح المرور» أدناه مفتاح تشغيل وإيقاف وقت التشغيل يغيّره مالك لوحة التحكم من هنا.",
    loading: "جارٍ التحميل…", failed: "تعذّر تحميل القائمة.",
    status: { on: "تعمل", partial: "ناقصة", off: "متوقفة" },
    required: "مطلوب", optional: "اختياري", set: "مضبوط", missing: "غير مضبوط", gatedOff: "متوقفة في الكود", gatedOn: "مفتاح في الكود",
    callback: "مسار الرجوع الذي يُضاف في تطبيق المنصة (بعد عنوان هذا الموقع)",
    webhook: "مسار الإشعارات (Webhook) الذي يُعطى لتطبيق المنصة (بعد عنوان هذا الموقع؛ في Shopify: حقول الامتثال الثلاثة)",
    compliance: "طلبات الامتثال من Shopify",
    pending: (n: number) => `طلبات حذف متاجر تنتظر تشغيل المتاجر القادم: ${n}`,
    none: "لم يصل أي طلب بعد.",
    topic: { "customers/data_request": "طلب بيانات عميل (لا نحتفظ بشيء)", "customers/redact": "حذف بيانات عميل (لا نحتفظ بشيء)", "shop/redact": "طلب حذف بيانات متجر في الانتظار", "app/uninstalled": "ألغى المتجر تثبيت التطبيق: الحذف في الانتظار", "shop/redact:done": "تم حذف بيانات المتجر" } as Record<string, string>,
    workspaces: (n: number) => `مساحات العمل: ${n}`,
    summary: (on: number, all: number) => `${on} من ${all} تعمل`,
    health: "الربط عبر مساحات العمل",
    healthNote: (n: number) => `عدّها تشغيل المتاجر في مساحات العمل: ${n}. أرقام فقط، ولا تُسمّى أي مساحة.`,
    healthNone: "لم تُعدّ بعد: يكتبها تشغيل المتاجر.",
    healthCols: { platform: "المنصة", connected: "مربوطة", reconnect: "تحتاج إعادة ربط", composio: "عبر Composio" },
    keepAlive: (k: KeepAlive) => `تجديد الرموز: منتهية ${k.due}، جُدّدت ${k.refreshed}، رفضتها المنصة ${k.lost}، تعذّرت ${k.failed}.`,
    keepAliveNone: "تجديد الرموز: غير مسجّل في هذا التشغيل.",
    hooks: (h: Hooks) => `إشعار إلغاء التثبيت في Shopify: متاجر بلا اشتراك ${h.due}، اشتركت ${h.subscribed}، تعذّر ${h.failed}.`,
    hooksNone: "إشعار إلغاء التثبيت في Shopify: غير مسجّل في هذا التشغيل.",
  },
} as const;

/** GET /api/admin/integrations `connections` (rules 2177-2178): the stores run's last count, numbers and names only. */
type KeepAlive = { due: number; refreshed: number; lost: number; failed: number };
type Hooks = { due: number; subscribed: number; failed: number };
type Connections = { at: string; workspaces: number; keepAlive: KeepAlive | null; uninstallHooks: Hooks | null; rows: { id: string; name: string; connected: number; reconnect: number; composio: number }[] };

const TONE: Record<IntegrationView["status"], BadgeTone> = { on: "success", partial: "warning", off: "neutral" };

/** The Passkeys row's words (rule 2426); the same keys in both languages. */
export const PASSKEYS_SWITCH_COPY = {
  en: {
    title: "Passkeys",
    what: "Customer sign-in with a passkey, and adding one in Settings > Security. A runtime switch, not an environment variable. Passwords keep working either way, so turning it off locks nobody out.",
    on: "On", off: "Off",
    onNow: "On: customers can sign in with a passkey and add new ones.",
    offNow: "Off: the passkey button and autofill are hidden and adding is stopped. Stored passkeys are kept, and customers can still list, rename and remove them.",
    turnOff: "Turn passkeys off", turnOn: "Turn passkeys on",
    offTitle: "Turn passkeys off?", onTitle: "Turn passkeys on?",
    offMessage: "Passkey sign-in and adding stop at once for every customer. No stored passkey is changed or deleted; turning it on again brings them all back.",
    onMessage: "Customers can sign in with their stored passkeys and add new ones again.",
    loadFailed: "Could not read the passkeys switch.",
    failed: "Could not change the switch.",
    forbidden: "Only a console owner can change this switch.",
    ownerOnly: "Only a console owner can change this switch; your role can see it only.",
    retry: "Try again",
  },
  ar: {
    title: "مفاتيح المرور",
    what: "دخول العملاء بمفتاح مرور، وإضافة مفتاح من الإعدادات > الأمان. مفتاح تشغيل وإيقاف وقت التشغيل، وليس متغير بيئة. كلمات المرور تعمل في الحالتين، فالإيقاف لا يمنع أحدًا من الدخول.",
    on: "تعمل", off: "متوقفة",
    onNow: "تعمل: يستطيع العملاء الدخول بمفتاح مرور وإضافة مفاتيح جديدة.",
    offNow: "متوقفة: زر مفتاح المرور والملء التلقائي مخفيان والإضافة متوقفة. المفاتيح المحفوظة باقية، ويستطيع العملاء عرضها وإعادة تسميتها وحذفها.",
    turnOff: "إيقاف مفاتيح المرور", turnOn: "تشغيل مفاتيح المرور",
    offTitle: "إيقاف مفاتيح المرور؟", onTitle: "تشغيل مفاتيح المرور؟",
    offMessage: "يتوقف الدخول بمفتاح المرور وإضافته فورًا لكل العملاء. لا يُغيَّر ولا يُحذف أي مفتاح محفوظ، وإعادة التشغيل تعيدها كلها.",
    onMessage: "يعود العملاء للدخول بمفاتيحهم المحفوظة وإضافة مفاتيح جديدة.",
    loadFailed: "تعذّرت قراءة حالة مفاتيح المرور.",
    failed: "تعذّر تغيير الحالة.",
    forbidden: "لا يغيّر هذا المفتاح إلا مالك لوحة التحكم.",
    ownerOnly: "لا يغيّر هذا المفتاح إلا مالك لوحة التحكم؛ دورك يتيح لك رؤيته فقط.",
    retry: "أعد المحاولة",
  },
} as const;

/**
 * The Passkeys row (rule 2426, spec flow E): GET /api/admin/passkeys for the state and `may` (whether this console role
 * may flip it); the toggle opens the console's reason form, then POSTs `{on, reason}` through `adminFetch`, which asks
 * the second factor when the server wants it and sends the request again. Only a console owner may flip it: for anyone
 * else the toggle is disabled with the "owner only" line, and the server answers 403 all the same. A failed read shows
 * a retry button. `initial` (and `initialMay`, default true) skip the read (tests render the row without a server).
 */
export function PasskeysSwitch({ lang, initial, initialMay }: { lang: "ar" | "en"; initial?: boolean; initialMay?: boolean }) {
  const C = PASSKEYS_SWITCH_COPY[lang];
  const [on, setOn] = useState<boolean | null>(initial ?? null);
  const [may, setMay] = useState(initialMay ?? true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const [askForm, formDialog] = useAdminForm(lang);
  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    const failed = () => { if (live) setLoadFailed(true); };
    adminFetch("/api/admin/passkeys").then((r) => r.json()).then((j) => {
      if (!live) return;
      if (j.ok && typeof j.on === "boolean") {
        setOn(j.on);
        setMay(j.may === true);
        setLoadFailed(false);
      } else failed();
    }).catch(failed);
    return () => { live = false; };
  }, [initial, lang, reads]);
  function retry() {
    setLoadFailed(false);
    setReads((n) => n + 1);
  }

  async function toggle() {
    if (on === null || !may) return;
    const next = !on;
    setMsg("");
    const v = await askForm({
      title: next ? C.onTitle : C.offTitle,
      message: next ? C.onMessage : C.offMessage,
      submitLabel: next ? C.turnOn : C.turnOff,
      destructive: !next,
      fields: [],
      parse: () => ({ ok: true, value: {} }),
    });
    if (!v) return;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/passkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: next, reason: v.reason }) });
      const j = await r.json().catch(() => ({}));
      if (j.ok && typeof j.on === "boolean") setOn(j.on);
      else if (j.error === "forbidden" || j.error === "read_only") setMsg(C.forbidden);
      else setMsg(typeof j.error === "string" && j.error.startsWith("reason_") ? inputError(lang, j.error) : C.failed);
    } catch {
      setMsg(C.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-sm" data-testid="integration-passkeys" aria-labelledby="integration-passkeys-title">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="integration-passkeys-title" className="font-semibold">{C.title}</h2>
          <p className="text-xs text-foreground-muted">{C.what}</p>
        </div>
        {on !== null && <Badge tone={on ? "success" : "warning"} className="shrink-0">{on ? C.on : C.off}</Badge>}
      </div>
      {on !== null && (
        <>
          <p role="status" className="mt-2 text-xs">{on ? C.onNow : C.offNow}</p>
          <button type="button" disabled={busy || !may} aria-describedby={may ? undefined : "integration-passkeys-owner-only"} onClick={() => void toggle()} className={`btn btn-sm mt-2 ${on ? "btn-danger" : "btn-primary"}`}>{on ? C.turnOff : C.turnOn}</button>
          {!may && <p id="integration-passkeys-owner-only" className="mt-1 text-xs text-foreground-muted">{C.ownerOnly}</p>}
        </>
      )}
      {loadFailed && (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-danger">
          <span>{C.loadFailed}</span>
          <button type="button" onClick={retry} className="btn btn-sm">{C.retry}</button>
        </p>
      )}
      {msg && <p role="alert" className="mt-2 text-xs text-danger">{msg}</p>}
      {formDialog}
    </section>
  );
}

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
      <PasskeysSwitch lang={lang} />
      <ConversionsCard lang={lang} />
      <section className="card card-sm" data-testid="integrations-connections">
        <h2 className="font-semibold">{L.health}</h2>
        {!connections ? <p className="mt-1 text-xs text-foreground-muted">{L.healthNone}</p> : (
          <>
            <p className="mt-1 text-xs text-foreground-muted">
              {L.healthNote(connections.workspaces)} <Time value={connections.at} lang={lang} style="datetime" className="tnum" />
            </p>
            <p className="mt-1 text-xs" data-testid="integrations-keepalive">
              {connections.keepAlive ? L.keepAlive(connections.keepAlive) : <span className="text-foreground-muted">{L.keepAliveNone}</span>}
              {connections.keepAlive && connections.keepAlive.lost + connections.keepAlive.failed > 0 && <Badge tone="warning" className="ms-2">{connections.keepAlive.lost + connections.keepAlive.failed}</Badge>}
            </p>
            <p className="mt-1 text-xs" data-testid="integrations-uninstall-hooks">
              {connections.uninstallHooks ? L.hooks(connections.uninstallHooks) : <span className="text-foreground-muted">{L.hooksNone}</span>}
              {connections.uninstallHooks && connections.uninstallHooks.failed > 0 && <Badge tone="warning" className="ms-2">{connections.uninstallHooks.failed}</Badge>}
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
