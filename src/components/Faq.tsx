import ScribbleStatic from "@/components/ScribbleStatic";
import type { Dict } from "@/lib/i18n";

/** The questions, drawn as prototype D (rule 518): an underlined title, no eyebrow label (rule 2317). */
export default function Faq({ t }: { t: Dict }) {
  return (
    <section id="faq" className="scroll-mt-20">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <h2 className="section-title">
          <span className="s-ul">
            <ScribbleStatic kind="underline" seed="faq-h" rtl={t.dir === "rtl"} />
            {t.faq.title}
          </span>
        </h2>
        <QaList items={t.faq.items} className="mt-8" />
      </div>
    </section>
  );
}

/** The question list itself, shared by the sector, comparison and definition pages. Questions are parted by space, not ruled lines (rule 2318). */
export function QaList({ items, className = "" }: { items: readonly { q: string; a: string }[]; className?: string }) {
  return (
    <div className={`grid gap-2 ${className}`}>
      {items.map((f) => (
        <details key={f.q} className="group py-4">
          <summary className="flex cursor-pointer items-center justify-between gap-4 font-display text-lg font-bold">
            {f.q}
            <span className="shrink-0 text-xl transition group-open:rotate-45 motion-reduce:transition-none" aria-hidden>
              +
            </span>
          </summary>
          <p className="mt-3 max-w-prose leading-relaxed text-foreground-muted">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
