import Link from "next/link";

/**
 * The 404 inside the language tree. It renders within `[lang]/layout.tsx`, so the document already carries the right
 * `lang` and `dir`; before this file existed every missing URL fell through to the framework default, which is an
 * untitled left-to-right English document with no navigation — on an Arabic-first site with 114 indexed URLs where a
 * mistyped blog link is an ordinary way to arrive.
 *
 * The body is bilingual because `not-found.tsx` receives no route params, so it cannot know which language it is in
 * without shipping client JavaScript to an error page.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-20 text-center">
      <p className="font-mono text-sm tracking-widest text-sadu">404</p>
      <div className="grid gap-2">
        <h1 className="font-display text-3xl font-semibold text-ink">الصفحة غير موجودة</h1>
        <p className="text-ink/70">الرابط الذي فتحته لم يعد موجوداً أو كُتب بشكل خاطئ.</p>
      </div>
      <div className="grid gap-2" dir="ltr">
        <h2 className="font-display text-xl font-medium text-ink">Page not found</h2>
        <p className="text-ink/70">The link you opened does not exist or was mistyped.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/ar" className="btn btn-primary">الصفحة الرئيسية</Link>
        <Link href="/en" className="btn btn-secondary">Home</Link>
      </div>
    </main>
  );
}
