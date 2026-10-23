"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { NEWSLETTER_COPY } from "@/lib/newsletter-copy";
import { failureCode, postJson, succeeded } from "@/lib/auth-client";
import Scribble from "@/components/Scribble";

/**
 * The newsletter sign-up box (rules 3600-3609): the footer of the public site and the blog. One email field, a consent box
 * that starts unticked, one button. It posts to /api/newsletter, which mails a confirm link; nothing is subscribed until
 * that link is pressed, and the box says so. `website` is the hidden field a person never sees: it is out of the tab order
 * and hidden from assistive technology, and a script that fills every field gives itself away (no CAPTCHA service).
 */
export default function NewsletterBox({ lang, source, id = "newsletter" }: { lang: Lang; source: "footer" | "blog" | "site"; id?: string }) {
  const c = NEWSLETTER_COPY[lang];
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [err, setErr] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "busy") return;
    const d = new FormData(e.currentTarget);
    setErr("");
    setState("busy");
    const p = await postJson("/api/newsletter", { email: String(d.get("email") ?? "").trim(), consent: d.get("consent") === "on", website: String(d.get("website") ?? ""), lang, source });
    if (succeeded(p)) { setState("sent"); return; }
    const code = p.body.error === "mail_off" ? "mail_off" : failureCode(p);
    setErr(code in c.errors ? c.errors[code as keyof typeof c.errors] : c.errors.server);
    setState("idle");
  }
  if (state === "sent") return <p role="status" className="s-card font-bold" data-testid="newsletter-sent"><Scribble kind="box" seed={`${id}-sent`} fill="lemon" />{c.sent}</p>;
  return (
    <form onSubmit={onSubmit} className="grid max-w-xl grid-cols-[minmax(0,1fr)] gap-3" aria-labelledby={`${id}-title`} data-testid="newsletter-box">
      <div>
        <h2 id={`${id}-title`} className="font-display text-lg font-bold text-foreground">{c.title}</h2>
        <p className="mt-1 text-sm">{c.sub}</p>
      </div>
      {/* The honeypot: off screen, not focusable, not announced. A person leaves it empty. */}
      <div aria-hidden="true" style={{ position: "absolute", insetInlineStart: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label>Website<input name="website" type="text" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-start text-sm font-bold">
        <span>{c.email}</span>
        <span className="s-input min-w-0 font-normal"><Scribble kind="box" seed={`${id}-email`} fill="paper" ring /><input name="email" required type="email" inputMode="email" autoComplete="email" dir="ltr" /></span>
      </label>
      {/* Never pre-ticked (no initial checked state): the visitor's own tick is the consent the server asks for. */}
      <label className="flex items-start gap-2 text-sm">
        <input name="consent" type="checkbox" required className="mt-1 size-4 shrink-0" />
        <span>{c.consent}</span>
      </label>
      {err && <p role="alert" className="text-sm font-bold text-danger">{err}</p>}
      <button disabled={state === "busy"} className="s-btn justify-self-start"><Scribble kind="pill" seed={`${id}-send`} fill="ink" shadow ring />{state === "busy" ? "…" : c.send}</button>
    </form>
  );
}
