import type { Dict } from "@/lib/i18n";

export default function Footer({ t }: { t: Dict }) {
  return (
    <footer className="bg-ink text-mist-dim">
      <div className="sadu-thin" aria-hidden />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="font-display text-xl font-bold text-mist">{t.brand}</p>
          <p className="mt-1 text-sm">{t.footer.tagline}</p>
        </div>
        <nav className="flex flex-wrap gap-5 text-sm" aria-label="Footer">
          {t.footer.links.map((l) => (
            <a key={l.label} href={l.href} className="hover:text-mist">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-xs sm:px-6">{t.footer.rights}</p>
    </footer>
  );
}
