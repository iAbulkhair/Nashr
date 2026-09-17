"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { TASK_COST } from "@/lib/brand";

type Data = { user: { name: string; email: string; phone: string; plan: string; credits: number; trialEnds: string; createdAt: string; lang: Lang }; usage: Record<string, { count: number; credits: number }>; images: number; emails: string };

export default function ProfilePanel({ lang }: { lang: Lang }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { fetch("/api/profile").then((x) => x.json()).then((j) => j.ok && setD(j)); }, []);
  if (!d) return <p className="text-ink/60">…</p>;
  const input = "w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm";
  const labels: Record<string, [string, string]> = { weekly_plan: ["خطة الأسبوع", "Weekly plan"], social: ["منشورات سوشال", "Social posts"], article: ["مقالات", "Articles"], whatsapp: ["رسائل واتساب", "WhatsApp"], ads: ["إعلانات", "Ads"], gbp: ["Google Business", "Google Business"] };
  const perItem: Record<string, string> = { weekly_plan: "1", social: "1", article: "2", whatsapp: "1", ads: "1", gbp: "1" };
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    setMsg(res.ok ? (ar ? "تم الحفظ" : "Saved") : (ar ? "خطأ" : "Error"));
    if (fd.lang && fd.lang !== lang) r.push(`/${fd.lang}/app/profile`);
    r.refresh();
  }
  async function password(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    const j = await res.json();
    setMsg(j.ok ? (ar ? "تم تغيير كلمة المرور" : "Password changed") : j.error === "wrong_password" ? (ar ? "كلمة المرور الحالية غير صحيحة" : "Current password is wrong") : (ar ? "كلمة المرور قصيرة" : "Password too short"));
    (e.target as HTMLFormElement).reset();
  }
  async function del() {
    const pw = prompt(ar ? "لتأكيد الحذف النهائي اكتب كلمة المرور:" : "To permanently delete, enter your password:");
    if (!pw) return;
    const res = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) { r.push(`/${lang}`); r.refresh(); } else setMsg(ar ? "كلمة المرور غير صحيحة" : "Wrong password");
  }
  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="rounded-xl border border-ink/10 bg-white p-5"><h2 className="font-display text-lg font-bold">{title}</h2><div className="mt-3">{children}</div></section>;
  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <h1 className="font-display text-3xl font-bold text-oasis">{ar ? "حسابك" : "Your profile"}</h1>
      {msg && <p role="status" className="rounded-lg bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}
      <Card title={ar ? "استخدام الكريدت هذا الشهر" : "Credit usage this month"}>
        <p className="text-sm text-ink/70">{ar ? "الخطة" : "Plan"}: <b>{d.user.plan}</b> · {ar ? "الرصيد" : "Balance"}: <b dir="ltr">{d.user.credits}</b>{d.user.plan === "trial" && <> · {ar ? "تنتهي التجربة" : "Trial ends"} <span dir="ltr">{d.user.trialEnds.slice(0, 10)}</span></>}</p>
        <table className="mt-3 w-full text-sm"><thead className="text-left text-xs text-ink/50"><tr><th className="py-1">{ar ? "النوع" : "Type"}</th><th>{ar ? "لكل عنصر" : "Per item"}</th><th>{ar ? "عناصر" : "Items"}</th><th>{ar ? "كريدت" : "Credits"}</th></tr></thead>
          <tbody>{Object.keys(TASK_COST).map((k) => <tr key={k} className="border-t border-ink/5"><td className="py-1">{labels[k]?.[ar ? 0 : 1] ?? k}</td><td className="font-mono">{perItem[k]}</td><td className="font-mono">{d.usage[k]?.count ?? 0}</td><td className="font-mono">{d.usage[k]?.credits ?? 0}</td></tr>)}<tr className="border-t border-ink/5"><td className="py-1">{ar ? "صور" : "Images"}</td><td className="font-mono">1</td><td className="font-mono">{d.images}</td><td className="font-mono">{d.images}</td></tr></tbody></table>
      </Card>
      <form onSubmit={save}><Card title={ar ? "البيانات" : "Details"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <input name="name" defaultValue={d.user.name} placeholder={ar ? "الاسم" : "Name"} className={input} />
          <input name="phone" defaultValue={d.user.phone} dir="ltr" placeholder="+966…" className={input} />
          <input value={d.user.email} disabled dir="ltr" className={input + " opacity-60"} />
          <select name="lang" defaultValue={d.user.lang} className={input}><option value="ar">العربية</option><option value="en">English</option></select>
        </div>
        <h3 className="mt-5 font-medium">{ar ? "إيميلات نور" : "Emails from Noor"}</h3>
        <div className="mt-2 grid gap-2 text-sm">
          {[["all", ar ? "كل شيء: الملخص اليومي والتنبيهات" : "Everything: daily brief and alerts"], ["important", ar ? "المهم فقط: أخطاء وما ينتظر موافقتك" : "Important only: errors and approvals"], ["none", ar ? "لا شيء (إيميلات الحساب والفوترة تصل دائماً)" : "None (account and billing emails always arrive)"]].map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="radio" name="emails" value={v} defaultChecked={d.emails === v} /> {l}</label>)}
        </div>
        <button className="mt-4 rounded-lg bg-oasis px-5 py-2.5 text-sm font-semibold text-mist">{ar ? "حفظ" : "Save"}</button>
      </Card></form>
      <form onSubmit={password}><Card title={ar ? "كلمة المرور" : "Password"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <input name="currentPassword" type="password" required placeholder={ar ? "الحالية" : "Current"} className={input} />
          <input name="newPassword" type="password" required minLength={8} placeholder={ar ? "الجديدة (8+)" : "New (8+)"} className={input} />
        </div>
        <button className="mt-4 rounded-lg border border-ink/20 px-5 py-2.5 text-sm">{ar ? "غيّر" : "Change"}</button>
      </Card></form>
      <Card title={ar ? "حذف الحساب" : "Delete account"}>
        <p className="text-sm text-ink/60">{ar ? "يحذف علامتك وملفاتك ومحتواك نهائياً. لا رجوع." : "Permanently deletes your brand, files and content. No undo."}</p>
        <button onClick={del} className="mt-3 rounded-lg border border-sadu px-5 py-2.5 text-sm text-sadu">{ar ? "احذف حسابي" : "Delete my account"}</button>
      </Card>
    </div>
  );
}
