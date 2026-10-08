"use client";
import { useRouter } from "next/navigation";

/** Ink text by default: the old lilac on paper (#efe7f7 on white) could not be seen, so nobody found the way out. Rule 750. */
export default function LogoutButton({ label, lang, className = "text-xs font-semibold text-ink underline-offset-2 hover:underline" }: { label: string; lang: string; className?: string }) {
  const r = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        r.push(`/${lang}/app/login`);
        r.refresh();
      }}
      className={className}
    >
      {label}
    </button>
  );
}
