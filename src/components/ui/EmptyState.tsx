import { Icon, type IconName } from "@/components/app/Icons";

/**
 * Nothing to show yet (rule 1116): what is missing, in one line, and the one thing to do about it. A plain region, not a
 * status or an alert: it is the screen's content, not news. No directive, so a server page can render it.
 */
export default function EmptyState({ icon = "spark", title, body, action, className = "" }: {
  icon?: IconName;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** A link or a button; the caller picks it, so its words and route are the caller's. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid justify-items-center gap-2 rounded-card border border-dashed border-border bg-paper px-6 py-10 text-center ${className}`}>
      <span className="grid h-11 w-11 place-items-center rounded-full bg-surface-muted text-ink" aria-hidden><Icon name={icon} className="h-5 w-5" /></span>
      <p className="font-display text-base font-bold text-ink">{title}</p>
      {body && <p className="max-w-prose text-sm text-foreground-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
