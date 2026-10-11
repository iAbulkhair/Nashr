"use client";
import { useEffect, useState } from "react";

/** The banner's words (rule 1177), Arabic and English, Western digits in both. */
export const IMPERSONATION_COPY = {
  en: {
    label: "Founder view",
    viewing: "You are viewing as",
    left: (m: number) => (m <= 1 ? "less than a minute left" : `${m} minutes left`),
    over: "time is up: the next page ends the view",
    stop: "Stop and return to console",
  },
  ar: {
    label: "عرض المؤسس",
    viewing: "تتصفح بصفة",
    left: (m: number) => (m <= 1 ? "بقيت أقل من دقيقة" : `بقيت ${m} دقيقة`),
    over: "انتهى الوقت: الصفحة التالية تُنهي العرض",
    stop: "إنهاء والعودة إلى اللوحة",
  },
} as const;

/** Whole minutes left until `until` (epoch ms), rounded up, never below 0. Pure for the tests. */
export function minutesLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 60_000));
}

/**
 * The founder's impersonation banner (rule 1177): sticky at the top of the app's main column while the session is a
 * founder's view of an account (`user.actor.kind === "founder"`, never the cookie alone). It names the account (from the
 * session, set apart left to right), counts down to the length the founder chose (`actor.until`, the session's `exp`),
 * and its Stop button posts to `POST /api/admin/impersonate`, which ends the view and returns to the console. The
 * countdown starts after the page loads (so the server and the browser render the same first frame) and is not a live
 * region, so a screen reader is not interrupted every half minute. Stop is a 44px target.
 */
export default function ImpersonationBanner({ lang, email, until }: { lang: "ar" | "en"; email: string; until?: number }) {
  const C = IMPERSONATION_COPY[lang];
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 30_000);
    return () => { clearTimeout(first); clearInterval(every); };
  }, []);
  const left = until !== undefined && now !== null ? minutesLeft(until, now) : null;
  return (
    <form
      action="/api/admin/impersonate"
      method="post"
      aria-label={C.label}
      className="sticky top-0 z-30 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border-[1.5px] border-danger bg-paper px-3 py-2 text-sm text-ink"
      data-impersonation-banner
    >
      <input type="hidden" name="lang" value={lang} />
      <p className="min-w-0">
        <span className="font-semibold">{C.viewing}</span> <bdi className="break-all font-mono" dir="ltr">{email}</bdi>
        {left !== null && <span className="tabular-nums text-muted"> · {left > 0 ? C.left(left) : C.over}</span>}
      </p>
      <button type="submit" className="btn btn-danger min-h-[var(--hit-min)] px-3 text-sm">{C.stop}</button>
    </form>
  );
}
