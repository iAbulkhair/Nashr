import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getClient, validRedirectUri } from "@/lib/oauth";
import { can } from "@/lib/roles";
import ConsentForm from "./ConsentForm";
// Renders its own document outside the [lang] layout, so it loads the D tokens itself and never writes a colour value.
import "../../tokens.css";

export const dynamic = "force-dynamic";

/**
 * The consent screen's words (rule 1589). It sits outside the [lang] tree, so it reads the language from `?lang=` or the
 * browser's Accept-Language: Arabic unless the browser asks for English, as on the rest of the site.
 */
const T = {
  ar: {
    cannot: "لا يمكن إتمام الربط",
    errors: { client: "التطبيق غير معروف.", redirect: "عنوان الرجوع غير مسجّل لهذا التطبيق.", https: "عنوان الرجوع يجب أن يكون https، أو http على الجهاز نفسه.", code: "نوع الطلب يجب أن يكون code.", pkce: "الطلب ينقصه PKCE." },
    ownerOnly: "مالك الحساب وحده يربط التطبيقات بهذا الحساب. اطلب منه الموافقة من حسابه.",
    signedIn: "مسجّل الدخول باسم",
    allowQ: (app: string) => <>هل تسمح لـ <b>{app}</b> باستخدام نور؟</>,
    can: "سيتمكن التطبيق من: المحادثة مع نور، وإنشاء محتوى في صندوقك (يستهلك الكريدت)، وقراءة ملفات مساحة عملك.",
    sends: "الموافقة ترسل رمز الربط إلى",
    unknownAddress: "عنوان غير معروف",
    warn: "أي مطوّر يستطيع تسجيل تطبيق بأي اسم. تابع فقط إذا كنت تعرف هذا العنوان.",
    allow: "اسمح",
    deny: "ارفض",
    failed: "تعذّر إتمام الربط. حدّث الصفحة وجرّب مرة ثانية.",
    revoke: "تستطيع إلغاء الوصول متى شئت من ذكين ← MCP ← إلغاء، أو بإنشاء رمز شخصي جديد.",
  },
  en: {
    cannot: "Cannot authorize",
    errors: { client: "unknown client", redirect: "redirect_uri not registered", https: "redirect_uri must be https, or http on the loopback interface", code: "response_type must be code", pkce: "PKCE required" },
    ownerOnly: "Only the account owner can connect apps to this account. Ask the owner to approve it from their own login.",
    signedIn: "Signed in as",
    allowQ: (app: string) => <>Allow <b>{app}</b> to use Noor?</>,
    can: "The app will be able to: chat with Noor, create content in your inbox (uses credits), read your workspace files.",
    sends: "Approving sends your authorization code to",
    unknownAddress: "an unknown address",
    warn: "Any developer can register an app under any name. Only continue if you recognise that address.",
    allow: "Allow",
    deny: "Deny",
    failed: "Connecting did not finish. Refresh the page and try again.",
    revoke: "You can revoke access any time from Thakeen → MCP → Revoke, or by generating a new personal token.",
  },
};

/** OAuth consent screen. Unauthenticated users are sent to login and bounced back here. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const lang = q.lang === "en" || (q.lang !== "ar" && /^en\b/i.test((await headers()).get("accept-language") ?? "")) ? "en" : "ar";
  const t = T[lang];
  const u = await currentUser();
  const self = "/oauth/authorize?" + new URLSearchParams(Object.entries(q).filter(([, v]) => v != null) as [string, string][]).toString();
  if (!u) redirect(`/${lang}/app/login?next=${encodeURIComponent(self)}`);
  const client = q.client_id ? await getClient(q.client_id) : null;
  const bad = !client ? t.errors.client : !q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri) ? t.errors.redirect : !validRedirectUri(q.redirect_uri) ? t.errors.https : q.response_type !== "code" ? t.errors.code : !q.code_challenge ? t.errors.pkce : null;
  // Connecting an app hands it the whole account, so only the owner, signed in as themselves, is offered the form.
  // /api/oauth/approve refuses everyone else in code; this only saves them a form that cannot work.
  const ownerOnly = !can(u, "oauth.approve") ? t.ownerOnly : null;
  const who = u.actor?.email ?? u.email;
  // Client registration is open, so the name on this screen is whatever the app called itself — "Nashr Mobile" is a
  // name anyone can claim. The one fact the owner can actually judge is where the authorization code will be sent, so
  // show that host rather than leaving it buried in a hidden input.
  const destination = (() => { try { return new URL(q.redirect_uri ?? "").host; } catch { return ""; } })();
  return (
    <html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
      <body style={{ fontFamily: "system-ui, sans-serif", background: "var(--color-ground)", color: "var(--color-ink)", margin: 0 }}>
        <main style={{ maxWidth: 440, margin: "10vh auto", background: "var(--color-paper)", border: "1.5px solid var(--color-ink)", borderRadius: 16, padding: 28 }}>
          <p style={{ fontSize: 12, letterSpacing: lang === "ar" ? 0 : 2, textTransform: "uppercase", color: "var(--color-muted)", margin: 0 }}>{lang === "ar" ? "ذكين · نور" : "Thakeen · Noor"}</p>
          {bad || ownerOnly ? (
            <><h1 style={{ fontSize: 20 }}>{t.cannot}</h1><p style={{ color: "var(--color-muted)" }}>{bad ?? ownerOnly}</p>{!bad && <p style={{ color: "var(--color-muted)", fontSize: 12 }}>{t.signedIn} <b dir="ltr">{who}</b>.</p>}</>
          ) : (
            <>
              <h1 style={{ fontSize: 22, margin: "8px 0 4px" }}>{t.allowQ(client!.client_name || client!.client_id)}</h1>
              <p style={{ color: "var(--color-muted)", fontSize: 14 }}>{t.signedIn} <b dir="ltr">{who}</b>. {t.can}</p>
              <p style={{ background: "color-mix(in srgb, var(--color-agent-sami) 20%, var(--color-paper))", border: "1.5px solid var(--color-danger)", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "var(--color-ink)" }}>
                {t.sends} <b dir="ltr" style={{ wordBreak: "break-all" }}>{destination || t.unknownAddress}</b>.
                <br />
                <span style={{ color: "var(--color-muted)", fontSize: 12 }}>{t.warn}</span>
              </p>
              <ConsentForm fields={Object.fromEntries((["client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"] as const).map((k) => [k, q[k] ?? ""]))} allow={t.allow} deny={t.deny} failed={t.failed} />
              <p style={{ fontSize: 12, color: "var(--color-muted)", marginTop: 16 }}>{t.revoke}</p>
            </>
          )}
        </main>
      </body>
    </html>
  );
}
