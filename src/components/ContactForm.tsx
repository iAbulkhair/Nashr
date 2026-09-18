"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { SITE } from "@/lib/site";

/** Posts to /api/support (stored as a ticket, emailed when mail is configured). `kind` tags the ticket. */
export default function ContactForm({ lang, kind, page }: { lang: Lang; kind: "enterprise" | "early-adopter"; page: string }) {
  const f = SITE[lang].form;
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("busy");
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const message = [`Name: ${d.name}`, `Company: ${d.company}`, "", d.message].join("\n");
    const r = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: d.email, message, type: kind, page, lang }) }).catch(() => null);
    setState(r?.ok ? "sent" : "error");
  }
  if (state === "sent") return <p role="status" className="rounded-xl border border-oasis/30 bg-salt p-4 text-oasis">{f.sent}</p>;
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="name" required autoComplete="name" placeholder={f.name} aria-label={f.name} className="input" />
        <input name="email" required type="email" autoComplete="email" dir="ltr" placeholder={f.email} aria-label={f.email} className="input" />
      </div>
      <input name="company" required autoComplete="organization" placeholder={f.company} aria-label={f.company} className="input" />
      <textarea name="message" required rows={4} placeholder={f.message} aria-label={f.message} className="input" />
      {state === "error" && <p role="alert" className="text-sm text-sadu-deep">{f.error}</p>}
      <button disabled={state === "busy"} className="btn btn-primary justify-self-start">{state === "busy" ? "…" : f.send}</button>
    </form>
  );
}
