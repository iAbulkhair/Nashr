/**
 * A status box (rule 1087): an icon, an optional title and the words, on the tone's tint. `danger` is an error and is
 * announced at once (`role="alert"`); the others are `role="status"`, read when the person is free; `role` overrides
 * (a standing note on a page is `note`). The icon's shape differs per tone, so the tone is never colour alone. Danger is
 * for errors only; a heads-up that is not an error is `warning` or `notice`. No hooks, so server components use it too.
 */
export type CalloutTone = "info" | "notice" | "success" | "warning" | "danger";

const PATHS: Record<CalloutTone, React.ReactNode> = {
  // i in a circle
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  // a padlock: a note about what this person cannot change
  notice: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  // a tick in a circle
  success: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></>,
  // a triangle with a bar
  warning: <><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4M12 17h.01" /></>,
  // a circle with a cross
  danger: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
};

export default function Callout({ tone = "info", title, role, className = "", children, ...rest }: Omit<React.ComponentProps<"div">, "title"> & { tone?: CalloutTone; title?: React.ReactNode }) {
  return (
    <div {...rest} role={role ?? (tone === "danger" ? "alert" : "status")} className={`callout callout-${tone} ${className}`.trim()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="callout-icon" aria-hidden>{PATHS[tone]}</svg>
      <div className="min-w-0 flex-1">
        {title && <p className="callout-title">{title}</p>}
        <div className={title ? "mt-0.5" : undefined}>{children}</div>
      </div>
    </div>
  );
}
