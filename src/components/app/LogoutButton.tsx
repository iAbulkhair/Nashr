"use client";
import { useRouter } from "next/navigation";

export default function LogoutButton({ label, lang, className = "text-xs text-lilac/75 hover:text-lilac" }: { label: string; lang: string; className?: string }) {
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
