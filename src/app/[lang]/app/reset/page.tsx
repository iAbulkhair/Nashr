import { notFound } from "next/navigation";
import { Suspense } from "react";
import { isLang } from "@/lib/i18n";
import { ResetForm } from "@/components/app/AuthForm";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <Suspense><ResetForm lang={lang} /></Suspense>;
}
