import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { CORE_FILES, listFiles } from "@/lib/files";
import { can } from "@/lib/roles";
import FilesPanel from "@/components/app/FilesPanel";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("files");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Core memory is written and deleted by admins and the owner only; everyone else reads it here.
  const locked = can(u, "files.core.write") && can(u, "files.core.delete") ? [] : [...CORE_FILES];
  return <FilesPanel t={appDict[lang]} files={await listFiles(sc(u))} canImport={can(u, "catalog.import")} locked={locked} />;
}
