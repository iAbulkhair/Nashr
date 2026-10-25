"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Scribble from "@/components/Scribble";

const MSG = {
  ar: {
    wrong: "المفتاح أو الرمز غير صحيح.",
    slow: "محاولات كثيرة. حاول بعد ربع ساعة.",
    other: "تعذّر الدخول الآن. حاول مرة أخرى.",
    title: "دخول الطوارئ بالمفتاح",
    note: "للطوارئ فقط. الدخول اليومي بحساب الموظف.",
    staff: "الدخول بحساب الموظف",
    key: "مفتاح الأدمن",
    code: "رمز لوحة المؤسس (6 أرقام) أو رمز الاسترداد",
    codeHint: "مطلوب إن فعّلت التحقق بخطوتين للوحة.",
    show: "إظهار المفتاح",
    hide: "إخفاء المفتاح",
    paste: "الصق المفتاح أو اكتبه بنفسك: مدير كلمات المرور لا يملأ هذا الحقل.",
  },
  en: {
    wrong: "Wrong key or code.",
    slow: "Too many attempts. Try again in 15 minutes.",
    other: "Could not sign in right now. Try again.",
    title: "Break-glass key sign-in",
    note: "For emergencies only. Daily sign-in is your staff login.",
    staff: "Sign in with your staff login",
    key: "Admin key",
    code: "Console code (6 digits) or recovery code",
    codeHint: "Needed once two-step verification is on for the console.",
    show: "Show the key",
    hide: "Hide the key",
    paste: "Paste or type the key yourself: password managers do not fill this field.",
  },
} as const;

/**
 * The break-glass key form (rules 1645, 3705), reached only by its direct address `/{lang}/admin?login=1`: no normal
 * screen links to it. The key field is kept away from password managers (a saved customer password autofilled here was
 * refused as a wrong key): its own name and id, `autocomplete="new-password"`, the managers' ignore attributes, and a
 * show toggle so the founder can see what was pasted. The server trims surrounding spaces too.
 */
export default function AdminLogin({ lang = "en" }: { lang?: "ar" | "en" }) {
  const ar = lang === "ar";
  const r = useRouter();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const key = String(form.get("bg-admin-key") ?? "").trim();
    const code = String(form.get("bg-console-code") ?? "").replace(/\s+/g, "");
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, code }) });
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
      <h1 className="font-display text-2xl font-bold text-foreground"><span className="s-ul"><Scribble kind="underline" seed="adminlogin-t1" />{MSG[lang].title}</span></h1>
      <p className="text-sm text-foreground-muted">{MSG[lang].note} <a href={`/${lang}/admin/login`} className="underline">{MSG[lang].staff}</a></p>
      <div className="flex gap-2">
        <input
          id="bg-admin-key"
          name="bg-admin-key"
          type={show ? "text" : "password"}
          placeholder={MSG[lang].key}
          aria-label={MSG[lang].key}
          aria-describedby="adminlogin-key-hint"
          dir="ltr"
          className="input min-w-0 flex-1"
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore=""
          data-form-type="other"
        />
        <button type="button" className="text-sm underline" aria-pressed={show} aria-controls="bg-admin-key" onClick={() => setShow((v) => !v)}>{show ? MSG[lang].hide : MSG[lang].show}</button>
      </div>
      <p id="adminlogin-key-hint" className="text-xs text-foreground-muted">{MSG[lang].paste}</p>
      <input id="bg-console-code" name="bg-console-code" type="text" inputMode="text" placeholder={MSG[lang].code} aria-label={MSG[lang].code} aria-describedby="adminlogin-code-hint" dir="ltr" className="input" autoComplete="one-time-code" maxLength={40} data-1p-ignore="" data-lpignore="true" data-bwignore="" data-form-type="other" />
      <p id="adminlogin-code-hint" className="text-xs text-foreground-muted">{MSG[lang].codeHint}</p>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <button disabled={busy} className="s-btn"><Scribble kind="pill" seed="adminlogin-go" fill="ink" shadow ring />{ar ? "دخول" : "Enter"}</button>
    </form>
  );
}
