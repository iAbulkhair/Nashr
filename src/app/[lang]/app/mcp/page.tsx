import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import McpPanel from "@/components/app/McpPanel";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(`/${lang}/app/login`);
  const h = await headers();
  const origin = process.env.APP_ORIGIN ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  return <McpPanel lang={lang} origin={origin} />;
}
