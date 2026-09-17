import type { Dict } from "@/lib/i18n";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-sadu">{children}</p>;
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{children}</h2>;
}

export function Proof({ t }: { t: Dict }) {
  return (
    <section className="bg-salt-dim">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {t.proof.items.map((it) => (
          <div key={it.l}>
            <p className="font-display text-4xl font-bold text-oasis" dir="ltr">
              {it.n}
            </p>
            <p className="mt-1 text-sm text-ink/70">{it.l}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function How({ t }: { t: Dict }) {
  return (
    <section id="how" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t.how.eyebrow}</Eyebrow>
        <H2>{t.how.title}</H2>
        <ol className="mt-10 grid gap-6 md:grid-cols-5">
          {t.how.steps.map((s, i) => (
            <li key={s.title} className="relative border-t-2 border-oasis pt-4">
              <span className="font-mono text-xs text-oasis/60" dir="ltr">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-1 font-display text-lg font-medium">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/70">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Agents({ t }: { t: Dict }) {
  return (
    <section id="agents" className="scroll-mt-20 bg-oasis-deep text-mist">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t.agents.eyebrow}</Eyebrow>
        <H2>{t.agents.title}</H2>
        <p className="mt-3 max-w-xl text-mist-dim">{t.agents.sub}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {t.agents.items.map((a, i) => (
            <article key={a.name} className={`rounded-xl border p-5 ${i === 0 ? "border-saffron/60 bg-oasis md:col-span-2 lg:col-span-1" : "border-mist/10 bg-oasis/60"}`}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-saffron font-display text-lg font-bold text-ink" aria-hidden>
                  {a.name[0]}
                </span>
                <div>
                  <h3 className="font-display text-lg font-medium">{a.name}</h3>
                  <p className="text-xs text-mist-dim">{a.role}</p>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-mist/90">{a.body}</p>
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {a.does.map((d) => (
                  <li key={d} className="rounded bg-mist/10 px-2 py-0.5 text-[11px] text-mist-dim">
                    {d}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
      <div className="sadu-thin" aria-hidden />
    </section>
  );
}

export function Industries({ t }: { t: Dict }) {
  return (
    <section id="industries" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t.industries.eyebrow}</Eyebrow>
        <H2>{t.industries.title}</H2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-ink/10 bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
          {t.industries.items.map((it) => (
            <div key={it.name} className="bg-salt p-5">
              <h3 className="font-display font-medium">{it.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/70">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Integrations({ t }: { t: Dict }) {
  return (
    <section className="bg-salt-dim">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t.integrations.eyebrow}</Eyebrow>
        <H2>{t.integrations.title}</H2>
        <p className="mt-3 text-ink/70">{t.integrations.sub}</p>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {t.integrations.groups.map((g) => (
            <div key={g.label}>
              <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-oasis">{g.label}</h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {g.items.map((it) => (
                  <li key={it} className="rounded-full border border-ink/15 bg-salt px-3 py-1 text-sm">
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Calendar({ t }: { t: Dict }) {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t.calendar.eyebrow}</Eyebrow>
        <H2>{t.calendar.title}</H2>
        <p className="mt-3 max-w-xl text-ink/70">{t.calendar.sub}</p>
        <ul className="mt-10 divide-y divide-ink/10 border-y border-ink/10">
          {t.calendar.items.map((c) => (
            <li key={c.name} className="grid gap-1 py-4 sm:grid-cols-[140px_220px_1fr] sm:gap-6">
              <span className="font-mono text-sm text-sadu">{c.when}</span>
              <span className="font-display font-medium">{c.name}</span>
              <span className="text-sm text-ink/70">{c.play}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
