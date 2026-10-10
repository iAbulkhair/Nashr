"use client";
import ShellError from "@/components/app/ShellError";

/** A screen under /{lang}/app that throws shows this inside the app shell, not the whole-page error (rule 973). */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ShellError error={error} retry={retry} area="app" />;
}
