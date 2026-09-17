"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function AdminLogin({ lang = "en" }: { lang?: "ar" | "en" }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [err, setErr] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const key = new FormData(e.currentTarget).get("key");
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    if (res.ok) r.refresh();
    else setErr(true);
  }
  return (
    <form onSubmit={onSubmit} className="mx-auto grid max-w-sm gap-3">
      <h1 className="font-display text-2xl font-bold text-oasis">{ar ? "لوحة المؤسس" : "Founder console"}</h1>
      <input name="key" type="password" placeholder={ar ? "مفتاح الأدمن" : "Admin key"} dir="ltr" className="input" />
      {err && <p className="text-sm text-sadu">{ar ? "المفتاح غير صحيح." : "Wrong key."}</p>}
      <button className="btn btn-primary">{ar ? "دخول" : "Enter"}</button>
    </form>
  );
}
