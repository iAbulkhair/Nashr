"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { sendImage } from "@/lib/upload-client";
import Button from "@/components/ui/Button";
import CropDialog from "@/components/ui/CropDialog";
import WorkspaceLogo from "@/components/app/WorkspaceLogo";
import SettingsCard, { type CardStatus } from "./SettingsCard";

/** The logo policy as the browser checks it first (the server checks again: src/lib/upload.ts `LOGO_UPLOAD`). */
export const LOGO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

const COPY = {
  ar: {
    title: "شعار مساحة العمل",
    sub: "يظهر لكل أعضاء مساحة العمل بجانب اسمها في القائمة الجانبية ومبدّل مساحات العمل. JPEG أو PNG أو WebP حتى 5 ميجابايت؛ الخلفية الشفافة تصبح بيضاء.",
    pick: "اختر شعارًا", change: "غيّر الشعار", remove: "احذف الشعار", working: "يرفع…", crop: "اقتصاص الشعار",
    saved: "تم حفظ الشعار.", removed: "حُذف الشعار.",
    readOnly: "يغيّر الشعارَ المالكُ أو المشرف.",
    errors: { bad_type: "الصيغة غير مدعومة. اختر JPEG أو PNG أو WebP.", too_large: "الصورة أكبر من 5 ميجابايت.", slow_down: "محاولات كثيرة. حاول بعد قليل.", forbidden: "لا يمكن تغيير الشعار من هذه الجلسة.", generic: "تعذر حفظ الشعار. حاول مرة أخرى." },
  },
  en: {
    title: "Workspace logo",
    sub: "Shown to every member of the workspace beside its name in the sidebar and the workspace switcher. JPEG, PNG or WebP up to 5 MB; a transparent background becomes white.",
    pick: "Choose a logo", change: "Change logo", remove: "Remove logo", working: "Uploading…", crop: "Crop the logo",
    saved: "The logo is saved.", removed: "The logo is removed.",
    readOnly: "The owner or an admin changes the logo.",
    errors: { bad_type: "That format is not supported. Choose JPEG, PNG or WebP.", too_large: "The image is larger than 5 MB.", slow_down: "Too many tries. Try again shortly.", forbidden: "The logo cannot be changed from this session.", generic: "The logo could not be saved. Try again." },
  },
} as const;

/**
 * Rules 3610-3611: the workspace's logo. Everyone in the workspace sees it; only an owner or an admin (`workspace.logo`,
 * `canEdit`) gets the buttons, and the routes check the same role. A chosen file opens the crop (`CropDialog`, "contain",
 * so a wide mark can stay whole on white); the result is uploaded by `sendImage` to `/api/account/logo`.
 */
export default function LogoUpload({ lang, name, initial, canEdit }: { lang: Lang; name: string; initial: string | null; canEdit: boolean }) {
  const T = COPY[lang];
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [status, setStatus] = useState<CardStatus>(null);
  const errorText = (e: unknown) => (typeof e === "string" && e in T.errors ? T.errors[e as keyof typeof T.errors] : T.errors.generic);

  function choose(file: File) {
    if (input.current) input.current.value = "";
    if (!LOGO_TYPES.includes(file.type as (typeof LOGO_TYPES)[number])) return setStatus({ tone: "error", text: T.errors.bad_type });
    if (file.size > LOGO_MAX_BYTES) return setStatus({ tone: "error", text: T.errors.too_large });
    setStatus(null);
    setPicked(file);
  }

  async function upload(blob: Blob) {
    setBusy(true);
    setStatus(null);
    const r = await sendImage("/api/account/logo", blob);
    setBusy(false);
    if (!r.ok) return setStatus({ tone: "error", text: errorText(r.error) });
    setUrl(r.url);
    setStatus({ tone: "ok", text: T.saved });
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setStatus(null);
    const j = (await fetch("/api/account/logo", { method: "DELETE" }).then((r) => r.json()).catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!j.ok) return setStatus({ tone: "error", text: errorText(j.error) });
    setUrl(null);
    setStatus({ tone: "ok", text: T.removed });
    router.refresh();
  }

  return (
    <SettingsCard title={T.title} sub={T.sub} status={status} note={canEdit ? undefined : T.readOnly}>
      <div className="flex flex-wrap items-center gap-4">
        <WorkspaceLogo src={url} name={name} size={64} className="border border-border text-xl" />
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept={LOGO_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); }} />
            <Button variant="secondary" size="sm" loading={busy} loadingText={T.working} onClick={() => input.current?.click()}>{url ? T.change : T.pick}</Button>
            {url && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>{T.remove}</Button>}
          </div>
        )}
      </div>
      {picked && <CropDialog lang={lang} file={picked} fit="contain" title={T.crop} onCropped={(b) => { void upload(b); }} onClose={() => setPicked(null)} />}
    </SettingsCard>
  );
}
