"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { PlanItem } from "@/lib/chat";
import { render } from "@/lib/md";
import { Icon } from "./Icons";

const STR = {
  ar: { file: "ملف", saved: "محفوظ", expand: "عرض", collapse: "طيّ", copy: "نسخ", copied: "نُسخ", open: "فتح في الملفات", planHint: "اضغط + لإضافة المهمة إلى قائمتك، أو ابدأها الآن.", add: "أضف المهمة", added: "أُضيفت", start: "ابدأها الآن", skip: "تخطَّ", activate: "فعّل نور", firstUp: "أولاً", waTitle: "رقم واتساب (اختياري)", waBody: "نحفظه ليتواصل معك فريق ذكين عند الحاجة. لا نشاركه مع أحد.", waSave: "حفظ", waSaved: "حُفظ الرقم", waBad: "رقم غير صحيح", waLater: "لاحقاً" },
  en: { file: "File", saved: "Saved", expand: "Expand", collapse: "Collapse", copy: "Copy", copied: "Copied", open: "Open in Files", planHint: "Tap + to add a task to your list, or start it now.", add: "Add task", added: "Added", start: "Start now", skip: "Skip", activate: "Activate Noor", firstUp: "First up", waTitle: "WhatsApp number (optional)", waBody: "We keep it so the Thakeen team can reach you when needed. Never shared.", waSave: "Save", waSaved: "Number saved", waBad: "Invalid number", waLater: "Later" },
} as const;

/** A workspace file written by the agent, shown inline: collapsed preview, expand, copy. */
export function FileCard({ file, lang, defaultOpen = false }: { file: { name: string; content: string }; lang: "ar" | "en"; defaultOpen?: boolean }) {
  const S = STR[lang];
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  return (
    <article className="mt-2 overflow-hidden rounded-xl border border-ink/10 bg-white">
      <header className="flex items-center gap-2 border-b border-ink/5 px-3 py-2 text-xs">
        <Icon name="folder" className="h-4 w-4 text-ink" />
        <span className="font-mono font-semibold" dir="ltr">{file.name}</span>
        <span className="text-muted">{S.file}</span>
        <span className="badge badge-primary ms-auto">{S.saved}</span>
      </header>
      <div className={`prose-nashr prose-compact px-3 py-2 text-sm ${open ? "" : "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"}`} dir="auto" dangerouslySetInnerHTML={{ __html: render(file.content) }} />
      <footer className="flex flex-wrap items-center gap-1.5 border-t border-ink/5 px-3 py-2 text-xs">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="btn btn-secondary btn-xs">{open ? S.collapse : S.expand}</button>
        <button type="button" onClick={async () => { await navigator.clipboard.writeText(file.content); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-secondary btn-xs"><Icon name="copy" className="h-3.5 w-3.5" />{copied ? S.copied : S.copy}</button>
        <Link href={`/${lang}/app/files`} className="ms-auto text-muted underline">{S.open}</Link>
      </footer>
    </article>
  );
}

/** Starter plan from onboarding: each task can be added to the owner's list or started right away. */
export function PlanCard({ plan, lang, onStart }: { plan: PlanItem[]; lang: "ar" | "en"; onStart: (prompt: string) => void }) {
  const S = STR[lang];
  const [items, setItems] = useState(plan);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { fetch("/api/onboard/plan").then((r) => r.json()).then((j) => { if (j.ok && Array.isArray(j.plan) && j.plan.length === plan.length) setItems(j.plan); }).catch(() => {}); }, [plan.length]);
  async function add(i: number) {
    setItems((p) => p.map((x, n) => (n === i ? { ...x, added: true } : x)));
    await fetch("/api/onboard/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: i, added: true }) }).catch(() => {});
  }
  if (hidden) return null;
  return (
    <section className="mt-2 rounded-xl border border-ink/20 bg-white p-3">
      <p className="text-xs text-muted">{S.planHint}</p>
      <ol className="mt-2 grid gap-2">
        {items.map((it, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 px-3 py-2">
            <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
              <span className="tnum grid h-6 w-6 shrink-0 place-items-center rounded-full bg-lilac text-xs font-semibold">{i + 1}</span>
              <span className="min-w-0 flex-1 text-sm" dir="auto">{it.title}</span>
            </span>
            <button type="button" disabled={it.added} onClick={() => add(i)} className="btn btn-secondary btn-xs"><Icon name={it.added ? "check" : "plus"} className="h-3.5 w-3.5" />{it.added ? S.added : S.add}</button>
            <button type="button" onClick={() => onStart(`${it.title}\n\n${it.brief}`)} className="btn btn-primary btn-xs">{S.start}</button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => setHidden(true)} className="mt-2 text-xs text-muted underline">{S.skip}</button>
    </section>
  );
}

/** Phone is no longer asked at signup: ask for WhatsApp once value has been delivered. */
export function WhatsAppCard({ lang }: { lang: "ar" | "en" }) {
  const S = STR[lang];
  const [state, setState] = useState<"ask" | "saved" | "bad" | "hidden">("ask");
  const [v, setV] = useState("");
  if (state === "hidden") return null;
  if (state === "saved") return <p className="flex items-center gap-2 text-sm text-ink"><Icon name="check" className="h-4 w-4" />{S.waSaved}</p>;
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (v.replace(/\D/g, "").length < 9) return setState("bad"); const r = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: v }) }); setState(r.ok ? "saved" : "bad"); }} className="rounded-xl border border-ink/10 bg-ground p-3">
      <p className="text-sm font-semibold text-ink">{S.waTitle}</p>
      <p className="text-xs text-ink/70">{S.waBody}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={v} onChange={(e) => { setV(e.target.value); setState("ask"); }} type="tel" inputMode="tel" dir="ltr" placeholder="+9665xxxxxxxx" aria-label={S.waTitle} className="input max-w-56 py-1.5 text-sm" />
        <button className="btn btn-primary btn-xs">{S.waSave}</button>
        <button type="button" onClick={() => setState("hidden")} className="text-xs text-muted underline">{S.waLater}</button>
        {state === "bad" && <span role="alert" className="text-xs text-danger">{S.waBad}</span>}
      </div>
    </form>
  );
}

/** Sticky bar above the composer for trial accounts: the goal, the upgrade action, the first task. */
export function ActivationBar({ lang, goal, first }: { lang: "ar" | "en"; goal: string; first?: string }) {
  const S = STR[lang];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ink/15 bg-lemon/40 px-3 py-2 text-sm">
      <Icon name="spark" className="h-4 w-4 shrink-0 text-ink" />
      <span className="font-semibold" dir="auto">{goal}</span>
      {first && <span className="min-w-0 flex-1 text-xs text-ink/70" dir="auto">{S.firstUp}: {first}</span>}
      <Link href={`/${lang}/app/settings/billing`} className="btn btn-accent btn-xs ms-auto">{S.activate}</Link>
    </div>
  );
}
