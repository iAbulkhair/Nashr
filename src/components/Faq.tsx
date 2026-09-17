import type { Dict } from "@/lib/i18n";

export default function Faq({ t }: { t: Dict }) {
  return (
    <section id="faq" className="scroll-mt-20">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <p className="mb-3 eyebrow">{t.faq.eyebrow}</p>
        <h2 className="section-title">{t.faq.title}</h2>
        <div className="mt-8 divide-y divide-ink/10 border-y border-ink/10">
          {t.faq.items.map((f) => (
            <details key={f.q} className="group py-4">
              <summary className="flex items-center justify-between gap-4 font-display font-medium">
                {f.q}
                <span className="shrink-0 text-oasis transition group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-ink/70">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
