"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

export type LimitKind = "credits" | "trial";
/** Raise the paywall from anywhere on the client. */
export function raiseLimit(kind: LimitKind) {
  window.dispatchEvent(new CustomEvent("nashr:limit", { detail: { kind } }));
}
/** Map an API error to a limit kind, raising the modal. Returns true when handled. */
export function limitFromError(error?: string): boolean {
  if (error === "no_credits") { raiseLimit("credits"); return true; }
  if (error === "trial_over") { raiseLimit("trial"); return true; }
  return false;
}

export default function LimitModal({ t, lang }: { t: AppDict; lang: Lang }) {
  const [kind, setKind] = useState<LimitKind | null>(null);
  useEffect(() => {
    const on = (e: Event) => setKind((e as CustomEvent<{ kind: LimitKind }>).detail.kind);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setKind(null); };
    window.addEventListener("nashr:limit", on);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("nashr:limit", on); window.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => { if (kind) document.getElementById("limit-later")?.focus(); }, [kind]);
  if (!kind) return null;
  const L = t.limit;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="limit-title" className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" onClick={() => setKind(null)}>
      <div className="card w-full max-w-md p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-oasis font-display text-2xl font-bold text-saffron shadow-[0_0_0_8px_rgba(242,179,61,0.15)]" aria-hidden>ن</span>
        <h2 id="limit-title" className="mt-5 font-display text-2xl font-bold">{kind === "credits" ? L.creditsTitle : L.trialTitle}</h2>
        <p className="page-sub">{kind === "credits" ? L.creditsBody : L.trialBody}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button id="limit-later" onClick={() => setKind(null)} className="btn btn-secondary">{L.later}</button>
          <Link href={`/${lang}/app/billing`} className="btn btn-primary">{L.plans}</Link>
        </div>
      </div>
    </div>
  );
}
