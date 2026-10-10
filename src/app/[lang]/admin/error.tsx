"use client";
import ShellError from "@/components/app/ShellError";

/** A screen under /{lang}/admin that throws shows this inside the founder console shell, not the whole-page error (rule 977). */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ShellError error={error} retry={retry} area="admin" />;
}
