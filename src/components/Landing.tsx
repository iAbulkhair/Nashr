"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dict, Lang } from "@/lib/i18n";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-sadu">{children}</p>;
}
function H2({ children, light }: { children: React.ReactNode; light?: boolean }) {
  return <h2 className={`font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl ${light ? "text-mist" : ""}`}>{children}</h2>;
}

/** Hero: one field, your website URL. Same promise as the app's start wizard. */
export function HeroUrl({ t, lang }: { t: Dict; lang: Lang }) {
  const L = t.land.hero;
  const r = useRouter();
  const [url, setUrl] = useState("");
  function go(e: React.FormEvent) {
    e.preventDefault();
    const u = url.trim();
    const next = `/${lang}/app/start${u ? `?url=${encodeURIComponent(u)}` : ""}`;
    r.push(`/${lang}/app/signup?next=${encodeURIComponent(next)}`);
  }
  return (
    <section className="bg-oasis-deep text-mist">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-16 text-center sm:px-6 lg:pt-24">
        <p className="mb-5 text-sm font-medium text-saffron">{L.eyebrow}</p>
        <h1 className="font-display text-5xl font-bold leading-[1.08] tracking-tight sm:text-6xl lg:text-7xl">{L.title}</h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-mist-dim">{L.sub}</p>
        <form onSubmit={go} className="mx-auto mt-8 flex max-w-xl items-center gap-2 rounded-full border border-mist/15 bg-oasis p-1.5 shadow-2xl shadow-black/30">
          <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" dir="ltr" placeholder={L.urlPlaceholder} aria-label={L.urlPlaceholder} className="min-w-0 flex-1 bg-transparent px-4 py-3 text-sm text-mist placeholder:text-mist-dim focus:outline-none" />
          <button className="shrink-0 rounded-full bg-saffron px-5 py-3 text-sm font-semibold text-ink transition hover:bg-saffron/90">{L.urlCta}</button>
        </form>
        <p className="mt-4 text-sm font-medium">{L.assess}</p>
        <p className="mt-1 text-xs text-mist-dim">{L.trial}</p>
      </div>
      <div className="sadu" aria-hidden />
    </section>
  );
}

export function Highlights({ t }: { t: Dict }) {
  const L = t.land.highlights;
  return (
    <section className="bg-salt-dim">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <H2>{L.title}</H2>
        <p className="mt-3 max-w-xl text-ink/70">{L.sub}</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {L.items.map((it, i) => (
            <div key={it.t} className="rounded-xl border border-ink/10 bg-salt p-5">
              <span className="font-mono text-xs text-sadu" dir="ltr">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-2 font-display text-lg font-medium">{it.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/70">{it.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** "She works while you sleep": the night log becomes the proof. */
export function Teammate({ t }: { t: Dict }) {
  const L = t.land.teammate;
  return (
    <section className="bg-oasis-deep text-mist">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
        <div>
          <H2 light>{L.title}</H2>
          <p className="mt-4 max-w-lg leading-relaxed text-mist-dim">{L.body}</p>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {L.cards.map((c) => (
              <div key={c.label}>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-saffron">{c.label}</p>
                <h3 className="mt-2 font-display text-lg font-medium">{c.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-mist-dim">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-mist/10 bg-oasis p-5 shadow-2xl shadow-black/30 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-base font-medium">{t.hero.logTitle}</h3>
            <span className="inline-flex items-center gap-2 font-mono text-xs text-mist-dim"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-saffron opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-saffron" /></span>live</span>
          </div>
          <ol className="divide-y divide-mist/10">
            {t.hero.log.map((row, i) => (
              <li key={row.t} className="log-row flex gap-4 py-3" style={{ animationDelay: `${0.25 + i * 0.35}s` }}>
                <time className="w-12 shrink-0 pt-0.5 font-mono text-sm text-saffron" dir="ltr">{row.t}</time>
                <div className="min-w-0"><span className="mb-1 inline-block rounded bg-mist/10 px-1.5 py-0.5 text-[11px] font-medium text-mist-dim">{row.tag}</span><p className="text-sm leading-relaxed text-mist">{row.text}</p></div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-mist-dim">{t.hero.logNote}</p>
        </div>
      </div>
    </section>
  );
}

export function OldWay({ t }: { t: Dict }) {
  const L = t.land.oldway;
  return (
    <section>
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <H2>{L.title}</H2>
        <p className="mt-3 max-w-xl text-ink/70">{L.sub}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-ink/10 bg-salt-dim p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink/50">{L.old.label}</p>
            <ul className="mt-4 space-y-3">{L.old.items.map((x) => <li key={x} className="flex gap-3 text-sm text-ink/70"><span className="text-sadu">✕</span>{x}</li>)}</ul>
          </div>
          <div className="rounded-xl border border-oasis bg-oasis p-6 text-mist">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-saffron">{L.new.label}</p>
            <ul className="mt-4 space-y-3">{L.new.items.map((x) => <li key={x} className="flex gap-3 text-sm"><span className="text-saffron">✓</span>{x}</li>)}</ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Runs({ t }: { t: Dict }) {
  const L = t.land.runs;
  return (
    <section className="bg-salt-dim">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <H2>{L.title}</H2>
        <p className="mt-3 max-w-xl text-ink/70">{L.sub}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {L.items.map((it) => (
            <article key={it.tag} className="flex flex-col rounded-xl border border-ink/10 bg-salt p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sadu">{it.tag}</p>
              <p className="mt-3 font-display text-lg font-medium leading-snug">“{it.quote}”</p>
              <p className="mt-3 text-sm leading-relaxed text-ink/70">{it.does}</p>
              <p className="mt-auto pt-4 text-xs font-medium text-oasis">{it.proof}</p>
            </article>
          ))}
        </div>
        <p className="mt-8 rounded-xl border border-oasis/20 bg-salt p-4 text-center font-display text-lg text-oasis">{L.callout}</p>
      </div>
    </section>
  );
}

export function Deliverables({ t }: { t: Dict }) {
  const L = t.land.deliverables;
  return (
    <section>
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{L.eyebrow}</Eyebrow>
        <H2>{L.title}</H2>
        <p className="mt-3 max-w-xl text-ink/70">{L.sub}</p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {L.items.map((it) => (
            <div key={it.l} className="border-t-2 border-oasis pt-4">
              <p className="font-display text-4xl font-bold text-oasis" dir="ltr">{it.n}</p>
              <p className="mt-1 text-sm text-ink/70">{it.l}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-ink/50">{L.note}</p>
      </div>
    </section>
  );
}

export function Pillars({ t }: { t: Dict }) {
  const L = t.land.pillars;
  return (
    <section className="bg-oasis-deep text-mist">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <H2 light>{L.title}</H2>
        <p className="mt-3 max-w-xl text-mist-dim">{L.sub}</p>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {L.items.map((p) => (
            <div key={p.t} className="rounded-xl border border-mist/10 bg-oasis p-5">
              <h3 className="font-display text-lg font-medium">{p.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-mist-dim">{p.d}</p>
              <ul className="mt-4 flex flex-wrap gap-1.5">{p.chips.map((c) => <li key={c} className="rounded bg-mist/10 px-2 py-0.5 text-[11px] text-mist-dim">{c}</li>)}</ul>
            </div>
          ))}
        </div>
      </div>
      <div className="sadu-thin" aria-hidden />
    </section>
  );
}

export function Cta({ t, lang }: { t: Dict; lang: Lang }) {
  const L = t.land.cta;
  return (
    <section id="start" className="scroll-mt-20 bg-salt-dim">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{L.title}</h2>
        <p className="mt-3 text-ink/70">{L.sub}</p>
        <Link href={`/${lang}/app/signup`} className="mt-8 inline-block rounded-full bg-oasis px-8 py-3 font-semibold text-mist transition hover:bg-oasis-deep">{L.button}</Link>
      </div>
    </section>
  );
}
