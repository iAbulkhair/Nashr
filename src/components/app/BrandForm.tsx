"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Brand } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";

const input = "w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm";
const CHANNELS = ["instagram", "snapchat", "tiktok", "x", "linkedin", "whatsapp", "google"];

export default function BrandForm({ t, lang, initial }: { t: AppDict; lang: Lang; initial: Brand | null }) {
  const r = useRouter();
  const o = t.onboarding;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [langs, setLangs] = useState<string[]>(initial?.languages ?? [lang === "en" ? "en" : "ar"]);
  const [channels, setChannels] = useState<string[]>(initial?.channels ?? ["instagram", "snapchat", "tiktok", "whatsapp"]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/brand", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, languages: langs, channels }) });
    setBusy(false);
    if (res.ok) {
      setMsg(o.saved);
      r.push(`/${lang}/app/chat`);
      r.refresh();
    }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-oasis">{o.title}</h1>
      <p className="mt-2 text-ink/70">{o.sub}</p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <input name="name" required defaultValue={initial?.name} placeholder={o.name} className={input} />
          <input name="website" dir="ltr" defaultValue={initial?.website} placeholder={o.website} className={input} />
          <select name="industry" required defaultValue={initial?.industry ?? ""} className={input}>
            <option value="" disabled>{o.industry}</option>
            {o.industries.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
          <input name="city" defaultValue={initial?.city ?? (lang === "ar" ? "الرياض" : "Riyadh")} placeholder={o.city} className={input} />
          <select name="dialect" defaultValue={initial?.dialect ?? "saudi"} className={input} aria-label={o.dialect}>
            {Object.entries(o.dialects).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <fieldset className="flex items-center gap-4 text-sm">
            <legend className="sr-only">{o.languages}</legend>
            <span className="text-ink/60">{o.languages}:</span>
            {(["ar", "en"] as const).map((l) => (
              <label key={l} className="flex items-center gap-1.5">
                <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(langs, setLangs, l)} /> {o[l]}
              </label>
            ))}
          </fieldset>
        </div>
        <input name="tone" required defaultValue={initial?.tone} placeholder={o.tone} className={input} />
        <textarea name="products" required rows={3} defaultValue={initial?.products} placeholder={o.products} className={input} />
        <textarea name="audience" required rows={2} defaultValue={initial?.audience} placeholder={o.audience} className={input} />
        <textarea name="offers" rows={2} defaultValue={initial?.offers} placeholder={o.offers} className={input} />
        <div className="grid gap-3 sm:grid-cols-3">
          <input name="competitors" defaultValue={initial?.competitors} placeholder={o.competitors} className={input} />
          <input name="banned" defaultValue={initial?.banned} placeholder={o.banned} className={input} />
          <input name="preferred" defaultValue={initial?.preferred} placeholder={o.preferred} className={input} />
        </div>
        <fieldset className="flex flex-wrap items-center gap-2 text-sm">
          <legend className="mb-1 w-full text-ink/60">{o.channels}</legend>
          {CHANNELS.map((c) => (
            <button type="button" key={c} onClick={() => toggle(channels, setChannels, c)} className={`rounded-full border px-3 py-1 ${channels.includes(c) ? "border-oasis bg-oasis text-mist" : "border-ink/20 bg-white"}`}>
              {c}
            </button>
          ))}
        </fieldset>
        <button disabled={busy} className="rounded-lg bg-oasis px-5 py-3 font-semibold text-mist disabled:opacity-60">{o.save}</button>
        {msg && <p role="status" className="text-sm text-oasis">{msg}</p>}
      </form>
    </div>
  );
}
