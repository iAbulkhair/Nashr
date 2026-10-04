import type { Lang } from "@/lib/i18n";
import { RULE_TEXT, rulesStatus } from "@/lib/auth-client";

/**
 * The password rules with a state that does not depend on colour (rule 434): a visible check or cross, the words
 * "met" / "not met" for screen readers inside each item, and ONE live status line whose text changes ("2 of 3 password
 * rules met"). The list itself is not live: its text used to stay the same while only the colour changed, so a screen
 * reader announced nothing. The password inputs carry no native `minLength`: the browser would block the submit with
 * its own tooltip before the form could say which rule is unmet. Used by the signup and reset forms (AuthForm.tsx) and
 * the invite form (JoinForm.tsx).
 */
export function PasswordRules({ id, rules, checks, lang }: { id: string; rules: readonly string[]; checks: readonly boolean[]; lang: Lang }) {
  const T = RULE_TEXT[lang];
  return (
    <>
      <ul id={id} className="grid gap-1 text-xs">
        {rules.map((rule, i) => (
          <li key={rule} className={`flex items-center gap-2 ${checks[i] ? "text-ink" : "text-ink/60"}`}>
            <span aria-hidden className="inline-block w-3 text-center font-bold">{checks[i] ? "✓" : "✗"}</span>
            {rule}
            <span className="sr-only"> ({checks[i] ? T.met : T.unmet})</span>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">{rulesStatus(checks, lang)}</p>
    </>
  );
}
