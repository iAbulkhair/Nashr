import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { appHref } from "@/lib/app-href";

/**
 * Every brand page (rule 891, brand id in the URL "Part C"). The proxy gave this request `x-thakeen-brand` from the
 * path's `/b/{id}` segment (rule 887) and `currentUser()` took it as a selector among the session account's own active
 * brands (rule 886): another account's, an archived or an unknown brand is already Next's 404 there. What is left to
 * hold is the path itself: a segment the proxy could not use (malformed, so no header, so the session's last brand)
 * must not show that other brand under this address. So the path's brand is `u.brandId`, or the 404.
 */
export default async function BrandLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string; brand: string }> }) {
  const { lang, brand } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  if (brand !== u.brandId) notFound();
  return <>{children}</>;
}
