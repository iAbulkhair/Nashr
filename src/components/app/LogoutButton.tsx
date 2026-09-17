"use client";
import { useRouter } from "next/navigation";

export default function LogoutButton({ label, lang }: { label: string; lang: string }) {
  const r = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        r.push(`/${lang}/app/login`);
        r.refresh();
      }}
      className="text-xs text-mist-dim hover:text-mist"
    >
      {label}
    </button>
  );
}
