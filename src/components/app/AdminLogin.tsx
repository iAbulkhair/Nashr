"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const MSG = {
  ar: { wrong: "المفتاح غير صحيح.", slow: "محاولات كثيرة. حاول بعد ربع ساعة.", other: "تعذّر الدخول الآن. حاول مرة أخرى." },
  en: { wrong: "Wrong key.", slow: "Too many attempts. Try again in 15 minutes.", other: "Could not sign in right now. Try again." },
} as const;

export default function AdminLogin({ lang = "en" }: { lang?: "ar" | "en" }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const key = new FormData(e.currentTarget).get("key");
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      if (res.ok) return r.refresh();
      setErr(res.status === 401 ? MSG[lang].wrong : res.status === 429 ? MSG[lang].slow : MSG[lang].other);
    } catch {
      setErr(MSG[lang].other);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="mx-auto grid max-w-sm gap-3">
      <h1 className="font-display text-2xl font-bold text-oasis">{ar ? "لوحة المؤسس" : "Founder console"}</h1>
      <input name="key" type="password" placeholder={ar ? "مفتاح الأدمن" : "Admin key"} aria-label={ar ? "مفتاح الأدمن" : "Admin key"} dir="ltr" className="input" />
      {err && <p role="alert" className="text-sm text-sadu">{err}</p>}
      <button disabled={busy} className="btn btn-primary">{ar ? "دخول" : "Enter"}</button>
    </form>
  );
}
