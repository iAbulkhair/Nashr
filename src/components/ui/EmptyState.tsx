import { Icon, type IconName } from "@/components/app/Icons";

/**
 * Nothing to show yet (rule 1116): what is missing, in one line, and the one thing to do about it. A plain region, not a
 * status or an alert: it is the screen's content, not news. No directive, so a server page can render it.
 */
export default function EmptyState({ icon = "spark", title, body, action, compact = false, className = "" }: {
  icon?: IconName;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** A link or a button; the caller picks it, so its words and route are the caller's. */
  action?: React.ReactNode;
  /** Inside a card or a table (rule 2002): less padding, a smaller mark, so the card keeps its size. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`grid justify-items-center gap-2 rounded-card border border-dashed border-border bg-surface text-center ${compact ? "px-4 py-6" : "px-6 py-10"} ${className}`}>
      <span className={`grid place-items-center rounded-full bg-surface-muted text-foreground ${compact ? "h-9 w-9" : "h-11 w-11"}`} aria-hidden><Icon name={icon} className={compact ? "h-4 w-4" : "h-5 w-5"} /></span>
      <p className={`font-display font-bold text-foreground ${compact ? "text-sm" : "text-base"}`}>{title}</p>
      {body && <p className="max-w-prose text-sm text-foreground-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
