import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { ADMIN_LABEL, adminHref } from "@/lib/admin-gate";
import { EndedGate, EndedNotice } from "@/components/admin/shared";
import { EMAIL_TEMPLATES, type EmailTemplateId } from "@/emails";
import { renderSamples } from "@/emails/samples";

export const dynamic = "force-dynamic";

// Founder console, section "mail" (rules 1964-1965): the staff sign-in page without the gate (rule 1652).
export const generateMetadata = adminScreenMeta("mail");

const T = {
  en: { intro: "Every email template with fixed sample values, in Arabic and in English. Nothing is sent and nothing is read from customer data. The plain-text part is written by each caller and is not shown here.", ar: "Arabic", en: "English" },
  ar: { intro: "كل قالب بريد بقيم تجريبية ثابتة، بالعربية والإنجليزية. لا يُرسل شيء ولا يُقرأ شيء من بيانات العملاء. الجزء النصي يكتبه كل مرسل ولا يظهر هنا.", ar: "العربية", en: "الإنجليزية" },
} as const;

/**
 * The mail preview: each registered template (src/emails/index.ts) rendered with its sample (src/emails/samples.ts) in
 * both languages. Founder console only, behind `requireAdmin` like every section. Each document sits in an iframe with an
 * empty `sandbox`: no script, no form, no navigation of this page, so the email's own markup can never act on the console.
 * The documents are built by the templates, which escape every value (rule 686); nothing here comes from a request.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "mail"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const t = T[lang];
  const docs = { ar: renderSamples("ar"), en: renderSamples("en") };
  return (
    <EndedGate lang={lang} keySession={gate.keySession}>
      <section className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-bold">{ADMIN_LABEL[lang].mail}</h1>
          <p className="text-sm text-foreground-muted">{t.intro}</p>
        </header>
        {(Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[]).map((id) => (
          <article key={id} className="space-y-2" data-testid={`mail-preview-${id}`}>
            <h2 className="font-mono text-sm font-semibold" dir="ltr">{id}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {(["ar", "en"] as const).map((l) => (
                <figure key={l} className="space-y-1">
                  <figcaption className="text-xs text-foreground-muted">{t[l]}</figcaption>
                  <iframe title={`${id} (${l})`} sandbox="" srcDoc={docs[l][id]} className="h-[560px] w-full rounded-lg border border-border bg-surface" />
                </figure>
              ))}
            </div>
          </article>
        ))}
      </section>
    </EndedGate>
  );
}
