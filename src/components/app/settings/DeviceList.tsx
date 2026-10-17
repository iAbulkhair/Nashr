"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";
import { deviceName } from "@/lib/device-label";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { emptyCopy } from "@/lib/empty-copy";

const COPY = {
  ar: {
    heading: "الأجهزة اللي داخلة على حسابك", loading: "يحمّل الأجهزة…",
    current: "هذا الجهاز", end: "أخرجه", ending: "يُخرج…", ended: "خرج الجهاز.",
    needPw: "اكتب كلمة المرور فوق عشان تخرج جهاز.", since: "دخل", from: "من",
    older: "الجلسات اللي قبل هذي القائمة ما تنعرض هنا، وزر «اخرج من الأجهزة الأخرى» يخرجها كلها.",
    wrong: "كلمة المرور غير صحيحة.", slow: "محاولات كثيرة. جرّب بعد ساعة.", failed: "ما زبطت. جرّب مرة ثانية.",
  },
  en: {
    heading: "Devices signed in to your login", loading: "Loading devices…",
    current: "This device", end: "Sign out", ending: "Signing out…", ended: "That device is signed out.",
    needPw: "Type your password above to sign a device out.", since: "Signed in", from: "from",
    older: "Sessions from before this list existed are not shown; \"Sign out other devices\" ends them all.",
    wrong: "The password is wrong.", slow: "Too many tries. Try again in an hour.", failed: "That did not work. Try again.",
  },
} as const;

type Device = { id: string; ua: string; ip: string; at: number; current: boolean };

/**
 * The acting login's signed-in devices (rules 1938-1941), inside the "sign out other devices" card: each one names the
 * browser, the address and the sign-in time, this device is marked, and any other can be signed out with the password
 * typed in that card's field (`password`, cleared through `onUsed` once sent). The server finds the id in the login's
 * own list; nothing here can name another login's session.
 */
/** The acting login's devices, or null when they could not be read (an empty list is a real answer). */
async function readDevices(): Promise<Device[] | null> {
  const res = await fetch("/api/account/sessions").catch(() => null);
  const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; devices?: Device[] };
  return j.ok && Array.isArray(j.devices) ? j.devices : null;
}

export default function DeviceList({ lang, password, onUsed, forbidden, refresh = 0 }: { lang: Lang; password: string; onUsed: () => void; forbidden: string; refresh?: number }) {
  const T = COPY[lang];
  const [list, setList] = useState<Device[] | null>(null);
  // The last read failed: the list says so instead of the empty state, which would claim there are no other devices.
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const toast = useToast();

  const show = (d: Device[] | null) => { setUnread(d === null); if (d) setList(d); };
  const load = async () => show(await readDevices());
  useEffect(() => { void readDevices().then(show); }, [refresh]);

  async function end(id: string) {
    if (!password || busy) return;
    setBusy(id); setErr("");
    const res = await fetch("/api/account/sessions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, password }) }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string };
    setBusy(""); onUsed();
    // Rule 2001: the done line and a plain failure are toasts; permission, limit and wrong-password stay inline.
    if (j.ok) toast.success(T.ended);
    else if (res?.status === 403) setErr(forbidden);
    else if (res?.status === 429) setErr(T.slow);
    else if (j.error === "wrong_password") setErr(T.wrong);
    else toast.danger(T.failed);
    await load();
  }

  const when = (at: number) => dateFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, "Asia/Riyadh").format(new Date(at));
  const others = (list ?? []).filter((d) => !d.current).length;

  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold text-foreground">{T.heading}</h3>
      {unread ? <p role="alert" className="text-sm text-danger">{T.failed}</p> : list === null ? <PanelSkeleton label={T.loading} shape="rows" count={2} /> : (
        <ul className="grid gap-2">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <div className="grid">
                <span className="text-sm font-medium text-foreground">{deviceName(d.ua, lang)}{d.current && <span className="ms-2 rounded bg-surface-muted px-1.5 py-0.5 text-xs text-foreground-muted">{T.current}</span>}</span>
                <span className="text-xs text-foreground-muted" suppressHydrationWarning>{T.since} {when(d.at)}{d.ip ? ` · ${T.from} ` : ""}{d.ip && <bdi dir="ltr">{d.ip}</bdi>}</span>
              </div>
              {!d.current && <Button variant="secondary" size="sm" loading={busy === d.id} loadingText={T.ending} aria-disabled={!password || !!busy || undefined} onClick={() => void end(d.id)}>{T.end}</Button>}
            </li>
          ))}
          {others === 0 && <li><EmptyState compact title={emptyCopy(lang, "devices").title} body={emptyCopy(lang, "devices").body} /></li>}
        </ul>
      )}
      {others > 0 && !password && <p className="text-xs text-foreground-muted">{T.needPw}</p>}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <p className="text-xs text-foreground-muted">{T.older}</p>
    </div>
  );
}
