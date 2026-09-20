"use client";
import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary for the language tree. Without one, anything thrown while rendering a server component
 * replaced the whole page with the framework's default error document — no branding, no navigation, no language.
 *
 * Bilingual for the same reason as `not-found.tsx`: an error boundary has no route params to read.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest is what correlates this screen with the server log entry; the message itself may be redacted in production.
    console.error("route error", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-20 text-center">
      <div className="grid gap-2">
        <h1 className="font-display text-3xl font-semibold text-ink">صار خطأ غير متوقع</h1>
        <p className="text-ink/70">جرّب مرة أخرى. إذا تكرر، تواصل معنا وسنصلحه.</p>
      </div>
      <div className="grid gap-2" dir="ltr">
        <h2 className="font-display text-xl font-medium text-ink">Something went wrong</h2>
        <p className="text-ink/70">Try again. If it keeps happening, contact us and we will fix it.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button onClick={reset} className="btn btn-primary">إعادة المحاولة · Try again</button>
        <Link href="/ar" className="btn btn-secondary">الرئيسية · Home</Link>
      </div>
      {error.digest && <p className="font-mono text-xs text-ink/40" dir="ltr">ref: {error.digest}</p>}
    </main>
  );
}
