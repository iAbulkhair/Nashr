import Scribble from "@/components/Scribble";
import type { Dict } from "@/lib/i18n";

/** The questions, drawn as prototype D (rule 518): an underlined title over plain ink rules. */
export default function Faq({ t }: { t: Dict }) {
  return (
    <section id="faq" className="scroll-mt-20">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <p className="eyebrow">{t.faq.eyebrow}</p>
        <h2 className="section-title">
          <span className="s-ul">
            <Scribble kind="underline" seed="faq-h" />
            {t.faq.title}
          </span>
        </h2>
        <QaList items={t.faq.items} className="mt-8" />
      </div>
    </section>
  );
}

/** The question list itself, shared by the sector, comparison and definition pages. */
export function QaList({ items, className = "" }: { items: readonly { q: string; a: string }[]; className?: string }) {
  return (
    <div className={`divide-y divide-ink/15 border-y-[1.5px] border-ink ${className}`}>
      {items.map((f) => (
        <details key={f.q} className="group py-4">
          <summary className="flex cursor-pointer items-center justify-between gap-4 font-display text-lg font-bold">
            {f.q}
            <span className="shrink-0 text-xl transition group-open:rotate-45 motion-reduce:transition-none" aria-hidden>
              +
            </span>
          </summary>
          <p className="mt-3 leading-relaxed text-muted">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
