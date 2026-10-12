"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

const T = {
  ar: { title: "تعذّر عرض هذه الشاشة", body: "صار خطأ غير متوقع. جرّب مرة أخرى؛ إذا تكرر، تواصل معنا وسنصلحه.", retry: "إعادة المحاولة", home: "العودة للبداية" },
  en: { title: "This screen could not be shown", body: "Something went wrong. Try again; if it keeps happening, contact us and we will fix it.", retry: "Try again", home: "Back to the start" },
} as const;

/**
 * The error screen inside the app and founder console shells (rule 977): `app/error.tsx` and `admin/error.tsx` render it,
 * so a screen that throws keeps the sidebar and the language, where `[lang]/error.tsx` replaced the whole page. Quiet and
 * in one language: the page's own, read from the path, since an error boundary gets no route params. `home` is the
 * shell's own start (`/{lang}/app` or `/{lang}/admin`). `retry` (Next 16) fetches the screen again and renders it. The digest is what ties this screen to the server log.
 */
export default function ShellError({ error, retry, area }: { error: Error & { digest?: string }; retry: () => void; area: "app" | "admin" }) {
  const path = usePathname();
  const lang = path.startsWith("/en") ? "en" : "ar";
  const S = T[lang];
  useEffect(() => {
    console.error("screen error", error.digest ?? error.message);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-10 grid w-full max-w-lg gap-3 card p-6 text-start">
      <h1 className="font-display text-xl font-bold">{S.title}</h1>
      <p className="text-sm text-foreground-muted">{S.body}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" onClick={() => retry()} className="btn btn-primary btn-sm">{S.retry}</button>
        <Link href={`/${lang}/${area}`} className="btn btn-secondary btn-sm">{S.home}</Link>
      </div>
      {error.digest && <p className="font-mono text-xs text-foreground-muted" dir="ltr">ref: {error.digest}</p>}
    </div>
  );
}
