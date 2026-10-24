"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { sendImage } from "@/lib/upload-client";
import Button from "@/components/ui/Button";
import CropDialog from "@/components/ui/CropDialog";
import PersonAvatar from "@/components/app/PersonAvatar";
import SettingsCard, { type CardStatus } from "./SettingsCard";

/** The avatar policy as the browser checks it first (the server checks again: src/lib/upload.ts `AVATAR_UPLOAD`). */
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const COPY = {
  ar: {
    title: "صورتك",
    sub: "تظهر لك ولفريقك في القائمة الجانبية وقائمة الفريق، في كل مساحة عمل تنتمي إليها. JPEG أو PNG أو WebP حتى 5 ميجابايت.",
    pick: "اختر صورة", change: "غيّر الصورة", remove: "احذف الصورة", working: "يرفع…", crop: "اقتصاص صورتك",
    saved: "تم حفظ صورتك.", removed: "حُذفت صورتك.",
    errors: { bad_type: "الصيغة غير مدعومة. اختر JPEG أو PNG أو WebP.", too_large: "الصورة أكبر من 5 ميجابايت.", slow_down: "محاولات كثيرة. حاول بعد قليل.", forbidden: "لا يمكن تغيير الصورة من هذه الجلسة.", generic: "تعذر حفظ الصورة. حاول مرة أخرى." },
  },
  en: {
    title: "Your picture",
    sub: "Shown to you and your team in the sidebar and the team list, in every workspace you belong to. JPEG, PNG or WebP up to 5 MB.",
    pick: "Choose a picture", change: "Change picture", remove: "Remove picture", working: "Uploading…", crop: "Crop your picture",
    saved: "Your picture is saved.", removed: "Your picture is removed.",
    errors: { bad_type: "That format is not supported. Choose JPEG, PNG or WebP.", too_large: "The picture is larger than 5 MB.", slow_down: "Too many tries. Try again shortly.", forbidden: "The picture cannot be changed from this session.", generic: "The picture could not be saved. Try again." },
  },
} as const;

/**
 * Rule 3502: the person's picture. A chosen file opens the square crop (`CropDialog`, rule 3618); the cropped JPEG is
 * then uploaded by `sendImage` (planned at `/api/account/avatar/upload`: straight to a signing backend, else posted to
 * `/api/account/avatar`). The server checks, resizes and stores it either way.
 */
export default function AvatarUpload({ lang, name, email, initial, canEdit }: { lang: Lang; name: string; email: string; initial: string | null; canEdit: boolean }) {
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
    if (!AVATAR_TYPES.includes(file.type as (typeof AVATAR_TYPES)[number])) return setStatus({ tone: "error", text: T.errors.bad_type });
    if (file.size > AVATAR_MAX_BYTES) return setStatus({ tone: "error", text: T.errors.too_large });
    setStatus(null);
    setPicked(file);
  }

  async function upload(blob: Blob) {
    setBusy(true);
    setStatus(null);
    const r = await sendImage("/api/account/avatar", blob);
    setBusy(false);
    if (!r.ok) return setStatus({ tone: "error", text: errorText(r.error) });
    setUrl(r.url);
    setStatus({ tone: "ok", text: T.saved });
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setStatus(null);
    const j = (await fetch("/api/account/avatar", { method: "DELETE" }).then((r) => r.json()).catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!j.ok) return setStatus({ tone: "error", text: errorText(j.error) });
    setUrl(null);
    setStatus({ tone: "ok", text: T.removed });
    router.refresh();
  }

  return (
    <SettingsCard title={T.title} sub={T.sub} status={status} note={canEdit ? undefined : T.errors.forbidden}>
      <div className="flex flex-wrap items-center gap-4">
        <PersonAvatar src={url} name={name} email={email} size={64} className="text-xl" />
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept={AVATAR_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); }} />
            <Button variant="secondary" size="sm" loading={busy} loadingText={T.working} onClick={() => input.current?.click()}>{url ? T.change : T.pick}</Button>
            {url && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>{T.remove}</Button>}
          </div>
        )}
      </div>
      {picked && <CropDialog lang={lang} file={picked} fit="cover" title={T.crop} onCropped={(b) => { void upload(b); }} onClose={() => setPicked(null)} />}
    </SettingsCard>
  );
}
