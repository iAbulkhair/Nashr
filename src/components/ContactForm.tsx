"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { SITE } from "@/lib/site";
import Scribble from "@/components/Scribble";

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
  if (state === "sent") return <p role="status" className="s-card font-bold"><Scribble kind="box" seed="contact-sent" fill="lemon" />{f.sent}</p>;
  // Rule 1878: every field has a visible label above its box (the words stay when the field has text). The label's
  // `text-start` follows the page direction, so Arabic labels sit on the right.
  const box = (name: string, label: string, control: React.ReactNode) => (
    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-start text-sm font-bold" data-field={name}>
      <span>{label}</span>
      <span className="s-input min-w-0 font-normal"><Scribble kind="box" seed={`contact-${name}`} fill="paper" ring />{control}</span>
    </label>
  );
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
        {box("name", f.name, <input name="name" required autoComplete="name" />)}
        {box("email", f.email, <input name="email" required type="email" inputMode="email" autoComplete="email" dir="ltr" />)}
      </div>
      {box("company", f.company, <input name="company" required autoComplete="organization" />)}
      {box("message", f.message, <textarea name="message" required rows={4} />)}
      {state === "error" && <p role="alert" className="text-sm font-bold text-danger">{f.error}</p>}
      <button disabled={state === "busy"} className="s-btn justify-self-start"><Scribble kind="pill" seed="contact-send" fill="ink" shadow ring />{state === "busy" ? "…" : f.send}</button>
    </form>
  );
}
