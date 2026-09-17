"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function AdminLogin() {
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
    <form onSubmit={onSubmit} dir="ltr" className="mx-auto grid max-w-sm gap-3">
      <h1 className="font-display text-2xl font-bold text-oasis">Founder console</h1>
      <input name="key" type="password" placeholder="Admin key" className="rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm" />
      {err && <p className="text-sm text-sadu">Wrong key.</p>}
      <button className="rounded-lg bg-oasis px-5 py-3 font-semibold text-mist">Enter</button>
    </form>
  );
}
