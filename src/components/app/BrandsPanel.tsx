"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { ONBOARD_EXTRA_BRAND_COST } from "@/lib/pricing";
import { switchBrandPath } from "@/lib/brand-path";
import ReadOnlyNote from "./ReadOnlyNote";
import Scribble from "@/components/Scribble";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { usePrompt } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { useToast } from "@/components/ui/Toast";
import { useAppLink } from "@/components/app/WorkspaceContext";

type B = { id: string; name: string; createdAt: string; status: "active" | "archived"; hasBrandFile: boolean };

/**
 * `manage` (owner, admin): add, rename and archive. Everyone else can only switch their own active brand, and sees a
 * note instead of the add form. Display only: POST /api/brands refuses the same roles.
 *
 * Active brands are capped per plan (rules 1390-1392): GET /api/brands answers `cap` and `count`, shown as "N of cap".
 * At the cap the add form gives way to the plan message: a link to billing for the owner, "ask the account owner" for an
 * admin. The server is the check (402 brand_limit, read inside the brand list's lock); this is display only. Adding is
 * also bounded by a rate limit (429 slow_down) and a lock (409 busy). What an added brand costs is said here before
 * anyone adds one: its setup from its URL uses ONBOARD_EXTRA_BRAND_COST credits (rule 246), and its Sunday plan starts
 * off until switched on (rule 247).
 */
export default function BrandsPanel({ lang, manage = true, readOnlyNote = "" }: { lang: Lang; manage?: boolean; readOnlyNote?: string }) {
  const href = useAppLink(lang);
  const ar = lang === "ar";
  const r = useRouter();
  const path = usePathname();
  const [brands, setBrands] = useState<B[]>([]);
  const [active, setActive] = useState("default");
  // The plan's cap (0 until loaded, so nothing is shown as full before the answer) and whether this login may upgrade.
  const [cap, setCap] = useState(0);
  const [canUpgrade, setCanUpgrade] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  // One change at a time: a double click on Add sent two adds, and both passed the rate and the lock (two brands).
  const [busy, setBusy] = useState(false);
  // Rename asks in the app's own dialog (rule 1089), in the page's language, where `window.prompt` asked in the browser's.
  const [ask, promptDialog] = usePrompt(lang);
  const toast = useToast();
  async function load() { const j = await (await fetch("/api/brands")).json(); if (j.ok) { setBrands(j.brands); setActive(j.active); setCap(Number(j.cap) || 0); setCanUpgrade(!!j.canUpgrade); } }
  useEffect(() => { void Promise.resolve().then(load); }, []);
  async function act(body: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({ ok: false, error: String(res.status) }));
      if (!j.ok) {
        const nothing = ar ? "لم يتم التغيير. حاول مرة أخرى." : "Nothing changed. Try again.";
        // Rule 2001: a plain "nothing changed" is a toast; the rate, lock and plan-limit refusals stay in the page's alert.
        if (j.error !== "slow_down" && j.error !== "busy" && j.error !== "brand_limit") { setErr(""); toast.danger(nothing); return; }
        setErr(
          // Which window refused (src/lib/rate.ts `brandAddRefusal`): the day's can last until tomorrow, so never "shortly".
          j.error === "slow_down" ? (j.retry === "day"
            ? (ar ? "وصلت إلى حد العلامات الجديدة لهذا اليوم. حاول غداً." : "You reached today's limit for new brands. Try again tomorrow.")
            : (ar ? "أضفت علامات كثيرة خلال الساعة الأخيرة. حاول بعد ساعة." : "You added many brands in the last hour. Try again in an hour."))
          : j.error === "busy" ? (ar ? "تغيير آخر على العلامات جارٍ الآن. حاول مرة أخرى." : "Another brand change is in progress. Try again.")
          // The plan's cap (rule 1391): an add, or a restore of an archived brand, past the active brands the plan includes.
          : j.error === "brand_limit" ? (ar ? `وصلت إلى عدد العلامات النشطة في خطتك (${j.cap}). أرشف علامة أو رقِّ الخطة لإضافة غيرها.` : `You reached your plan's active brands (${j.cap}). Archive one or upgrade the plan to add another.`)
          // Any other refusal says so in words; the route's code is never shown (rule 1091).
          : nothing,
        );
        return;
      }
      setErr("");
      if (body.action === "add") { r.push(href("/start")); r.refresh(); return; }
      // A switch goes to the same section of the other brand (rule 893); from this account page that is the new brand's inbox.
      if (body.action === "switch") { r.push(switchBrandPath(path, body.id)); r.refresh(); return; }
      await load(); r.refresh();
    } finally {
      setBusy(false);
    }
  }
  const activeCount = brands.filter((b) => b.status === "active").length;
  // Full when the account has its plan's active brands (or more, after a downgrade: those keep working).
  const full = cap > 0 && activeCount >= cap;
  async function rename(b: B) {
    const n = await ask({ title: ar ? "إعادة تسمية العلامة" : "Rename the brand", label: ar ? "الاسم الجديد" : "New name", initial: b.name, submitLabel: ar ? "احفظ الاسم" : "Save the name", cancelLabel: ar ? "تراجع" : "Cancel", maxLength: 80 });
    if (n && n !== b.name) await act({ action: "rename", id: b.id, name: n });
  }
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="brandspanel-t1" />{ar ? "العلامات" : "Brands"}</span></h1>
      <p className="mt-2 text-foreground-muted">{ar ? "لكل علامة ملفها ومحتواها وقنواتها وإعداداتها. الكريدت مشترك بين علاماتك." : "Each brand has its own file, content, channels and settings. Credits are shared across brands."}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 card card-sm text-sm">
        <span>{ar ? "العلامات النشطة" : "Active brands"}: <b dir="ltr">{cap > 0 ? `${activeCount} / ${cap}` : activeCount}</b></span>
        {manage && full && (
          <p className="text-sm">
            {canUpgrade
              ? <>{ar ? "خطتك تشمل هذا العدد من العلامات. " : "Your plan includes this many brands. "}<Link href={href("/settings/billing")} className="font-semibold underline">{ar ? "رقِّ الخطة لإضافة علامة" : "Upgrade to add a brand"}</Link></>
              : (ar ? "خطة الحساب تشمل هذا العدد من العلامات. اطلب من مالك الحساب ترقية الخطة لإضافة علامة." : "The account's plan includes this many brands. Ask the account owner to upgrade the plan to add one.")}
          </p>
        )}
        {manage && !full && (
          <form onSubmit={(e) => { e.preventDefault(); void act({ action: "add", name }); }} className="flex w-full min-w-0 items-end gap-2 sm:w-auto">
            <Field label={ar ? "اسم العلامة الجديدة" : "New brand name"} hideLabel className="min-w-0 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={ar ? "اسم العلامة الجديدة" : "New brand name"} maxLength={80} />
            </Field>
            <Button type="submit" loading={busy}>+ {ar ? "أضف" : "Add"}</Button>
          </form>
        )}
      </div>
      {manage && (
        <p className="mt-2 text-xs text-foreground-muted">
          {ar
            ? `عدد العلامات النشطة حسب خطتك، والعلامات المؤرشفة لا تُحسب. إعداد علامتك الأولى مجاني، وإعداد كل علامة إضافية من رابطها يستخدم ${ONBOARD_EXTRA_BRAND_COST} كريدت من رصيد الحساب عند بدء الإعداد، ويُعاد إن تعذّر بناء ملف العلامة، وتعبئة النموذج يدوياً مجانية. خطة الأحد تبدأ متوقفة للعلامات المضافة، وتفعّلها من «المهام».`
            : `Your plan sets how many brands can be active; archived brands do not count. Your first brand's setup is free; setting up each added brand from its URL uses ${ONBOARD_EXTRA_BRAND_COST} credits from the account's balance when setup starts, refunded if the brand file cannot be built, and filling the form by hand is free. The Sunday plan starts off for added brands; switch it on in Tasks.`}
        </p>
      )}
      {!manage && readOnlyNote && <ReadOnlyNote text={readOnlyNote} />}
      {err && <Callout tone="danger" className="mt-3">{err}</Callout>}
      {promptDialog}
      <ul className="mt-6 grid gap-3">
        {brands.map((b) => (
          <li key={b.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${b.id === active ? "border-border-strong bg-surface" : "border-foreground/10 bg-surface"} ${b.status === "archived" ? "opacity-60" : ""}`}>
            <div>
              <p className="flex flex-wrap items-center gap-2 font-display font-medium"><bdi>{b.name}</bdi>{b.id === active && <Badge tone="inverse">{ar ? "نشطة" : "Active"}</Badge>}{b.status === "archived" && <Badge tone="neutral">{ar ? "مؤرشفة" : "Archived"}</Badge>}{!b.hasBrandFile && <Badge tone="warning">{ar ? "لم يكتمل الإعداد" : "Setup incomplete"}</Badge>}</p>
              <p className="mt-1 text-xs text-foreground-muted"><Time value={b.createdAt} lang={lang} /></p>
            </div>
            <div className="flex flex-wrap gap-2">
              {b.id !== active && b.status === "active" && <Button size="sm" disabled={busy} onClick={() => act({ action: "switch", id: b.id })}>{ar ? "انتقل" : "Switch"}</Button>}
              {manage && <Button variant="secondary" size="sm" disabled={busy} onClick={() => rename(b)}>{ar ? "إعادة تسمية" : "Rename"}</Button>}
              {manage && b.id !== "default" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: "archive", id: b.id })}>{b.status === "archived" ? (ar ? "استعادة" : "Restore") : (ar ? "أرشفة" : "Archive")}</Button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
