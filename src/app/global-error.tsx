"use client";

/**
 * Last resort: an error thrown by the layout itself, which is the one case a route-level `error.tsx` cannot catch.
 * This replaces the document, so it must render its own <html> and <body> and cannot use the app's fonts or styles;
 * the colours are prototype D's ground, ink and muted written out (src/app/tokens.css, rule 518).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f7f3f9", color: "#2b193d", margin: 0 }}>
        <main style={{ maxWidth: 520, margin: "12vh auto", textAlign: "center", padding: "0 24px" }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>صار خطأ غير متوقع</h1>
          <p style={{ color: "#5d4a70", marginTop: 0 }}>جرّب تحديث الصفحة.</p>
          <h2 style={{ fontSize: 18, marginTop: 28, marginBottom: 8 }} dir="ltr">Something went wrong</h2>
          <p style={{ color: "#5d4a70", marginTop: 0 }} dir="ltr">Try reloading the page.</p>
          <button onClick={reset} style={{ marginTop: 24, background: "#2b193d", color: "#ffffff", border: 0, borderRadius: 999, padding: "12px 20px", cursor: "pointer" }}>
            إعادة المحاولة · Try again
          </button>
          {error.digest && <p style={{ fontFamily: "monospace", fontSize: 12, color: "#5d4a70", marginTop: 20 }} dir="ltr">ref: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
