/**
 * What the verify page (src/components/app/VerifyForm.tsx) computes in the browser. Import-free and pure, so the client
 * bundle can use it and tests/email-verify-page.test.ts pins it.
 */

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits as 0-9, every other character left as it is (rule 2610). An Arabic keyboard
 * types a code in those digits and `\d` matches only 0-9, so the authenticator code checks (`src/lib/totp.ts`, `mfa.ts`,
 * `staff-code.ts`, `staff-admin.ts`, the staff sign-in route) and the customer setup button call this first.
 */
export const westernDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Digits only, Arabic-Indic and Persian digits turned into Latin (the same rule as `normalizeCode` in verify-email.ts, which is server-only). */
export function typedDigits(typed: string): string {
  return westernDigits(String(typed ?? "")).replace(/\D/g, "");
}

/** Seconds to wait from a `Retry-After` header: whole seconds, at least 1, `fallback` when the header is missing or not a number. */
export function retryWait(header: string | null | undefined, fallback = 60): number {
  const n = Number(header);
  return Number.isFinite(n) && n >= 1 ? Math.ceil(n) : fallback;
}

/** «بعد 45 ث» / "in 45s"; a wait over two minutes (the hourly limit) reads in minutes. */
export function waitLabel(seconds: number, lang: "ar" | "en"): string {
  const long = seconds > 120;
  const n = long ? Math.ceil(seconds / 60) : Math.max(1, Math.ceil(seconds));
  return lang === "ar" ? `بعد ${n} ${long ? "د" : "ث"}` : `in ${n}${long ? "m" : "s"}`;
}
