import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// The founder console moved to /{lang}/admin, its own route tree with its own layout (rule 872). Old bookmarks and
// links land there with their query kept (`?login=1` still opens the key form). A temporary redirect, not a 308: a
// browser caches a permanent one, which would outlive a rollback.
export const generateMetadata = appScreenMeta("admin");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) q.append(k, x);
  const s = q.toString();
  redirect(`/${lang}/admin${s ? `?${s}` : ""}`);
}
