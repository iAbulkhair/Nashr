"use client";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";

/**
 * The toggle's accessible name. One name for both states: `aria-pressed` says whether the password shows, so a screen
 * reader hears "Show password, toggle button, pressed" rather than a name that flips to "Hide password" and then also
 * reads as pressed. Kept here, like the rules' words in `RULE_TEXT`, because the reset form has the language only.
 */
export const PASSWORD_TOGGLE = {
  ar: "أظهر كلمة المرور",
  en: "Show password",
} as const;

/**
 * A password input with a show/hide toggle at its inline end. The button sits at `end-0` and the input keeps `pe-10` of
 * padding at the same end, so in Arabic and English alike the text never runs under the button. Every other attribute
 * (ref, id, name, autoComplete, value, onChange, required, autoFocus, placeholder, aria-*) goes to the input unchanged,
 * so the forms keep their refs, their live rule checks and their labels; only spellcheck, autocapitalise and autocorrect
 * are always off, for the reason given at the input. The toggle is `type="button"` and never submits
 * the form. On submit the password is hidden again before the form's own handler runs, so the browser never files it
 * with plain text fields in its autofill history.
 */
export default function PasswordField({ lang, className = "input", ...input }: Omit<React.ComponentProps<"input">, "type"> & { lang: Lang }) {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector("input");
    const form = el?.form;
    if (!el || !form) return;
    const hide = () => { el.type = "password"; setShown(false); };
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);
  return (
    <div ref={box} className="relative">
      {/* Shown, the password sits in a plain text field. Spellcheck services (Chrome's enhanced spellcheck, Edge's Editor)
          send text fields to their servers and phone keyboards capitalise and correct them, so all three are off, set after
          the spread where a caller cannot turn them back on. `unicode-bidi: plaintext` lays the characters out in the order
          they were typed (on an Arabic page "Secret123!" would otherwise show as "!Secret123") while the field keeps the
          page's direction, so its `pe-10` and the button's `end-0` stay on the same side. */}
      <input {...input} type={shown ? "text" : "password"} spellCheck={false} autoCapitalize="none" autoCorrect="off" className={`${className} pe-10 [unicode-bidi:plaintext]`} />
      <button type="button" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-label={PASSWORD_TOGGLE[lang]} className="absolute inset-y-0 end-0 grid w-10 place-items-center text-muted transition-colors hover:text-ink">
        {/* Drawn like the app's icon set (Icons.tsx): one stroke weight, currentColor. Struck through while the password shows. */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="m4 4 16 16" />}
        </svg>
      </button>
    </div>
  );
}
