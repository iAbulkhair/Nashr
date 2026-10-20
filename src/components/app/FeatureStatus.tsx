import type { Feature } from "@/lib/feature-status";
import Badge from "@/components/ui/Badge";

/**
 * Rule 2451: the Connections page's "What Thakeen has switched on" card. Server-rendered from `customerFeatures()`; on or
 * not yet, with a text badge (never colour alone), and no variable names.
 */
export default function FeatureStatus({ lang, features }: { lang: "ar" | "en"; features: Feature[] }) {
  const ar = lang === "ar";
  return (
    <section className="card mx-auto mb-6 w-full max-w-3xl" aria-labelledby="feature-status">
      <h2 id="feature-status" className="font-display font-medium">{ar ? "ما فعّله ذكين الآن" : "What Thakeen has switched on"}</h2>
      <p className="mt-1 text-sm text-foreground-muted">{ar ? "خدمات يشغّلها ذكين لكل الحسابات. ما لم يُفعَّل بعد لا يُخصم عليه أي كريدت، وتظهر بدلاً منه رسالة واضحة." : "Services Thakeen runs for every account. Anything not on yet uses no credits and says so plainly when you try it."}</p>
      <ul className="mt-3 divide-y divide-foreground/10">
        {features.map((f) => (
          <li key={f.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{f.name[lang]}</p>
              <p className="text-xs text-foreground-muted">{f.what[lang]}</p>
            </div>
            {/* Rule 1086: the words carry the state; no lemon on a light card (rule 1096). */}
            <Badge className="shrink-0" tone={f.on ? "success" : "neutral"} data-feature={f.id} data-on={f.on ? "1" : "0"}>{f.on ? (ar ? "يعمل" : "On") : (ar ? "لم يُفعَّل بعد" : "Not on yet")}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
