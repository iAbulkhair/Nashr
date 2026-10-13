import type { Lang } from "@/lib/i18n";
import { PRICES_AS_OF, type VsRow } from "@/lib/pages-vs";

/**
 * The competitor's cell (rule 1580). A stated price shows the day it was recorded and links the vendor's public page; a
 * row with a source and no figure ("see their pricing page") links that page itself.
 */
export default function VsThem({ row, lang }: { row: VsRow; lang: Lang }) {
  if (!row.src) return <>{row.them}</>;
  const link = "font-bold text-foreground underline";
  if (!/\d/.test(row.them)) return <a href={row.src} target="_blank" rel="noreferrer" className={link}>{row.them}</a>;
  return (
    <>
      {row.them}{" "}
      <span className="text-xs">
        ({lang === "ar" ? `بتاريخ ${PRICES_AS_OF.ar}، ` : `as of ${PRICES_AS_OF.en}, `}
        <a href={row.src} target="_blank" rel="noreferrer" className={link}>{lang === "ar" ? "المصدر" : "source"}</a>)
      </span>
    </>
  );
}
