import type { Lang } from "@/lib/i18n";
import { fallbackNotice, textAttrs } from "@/lib/lang-fallback";

/**
 * The notice above a page shown in another language than its URL's (rule 3313), written in the visitor's language: the text
 * below is the existing version because this one has not been translated. Nothing renders when the page is in the
 * visitor's own language.
 */
export default function LangFallbackNotice({ visitor, served }: { visitor: Lang; served: Lang }) {
  if (visitor === served) return null;
  return (
    <p role="note" data-testid="lang-fallback" {...textAttrs(visitor)} className="mb-6 border-[1.5px] border-border-strong bg-background-muted px-4 py-3 text-sm font-bold">
      {fallbackNotice(visitor, served)}
    </p>
  );
}
