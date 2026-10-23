import { percent } from "@/lib/chart-math";

/**
 * One progress bar (rule 3130). `role="progressbar"` with min, max, now and a name; the value is kept inside 0..max so a
 * count above its limit never reports an impossible state. The fill starts at the reading edge, so in RTL it grows from the
 * right with no extra code (a block child fills from the inline start).
 *
 * `size` is the track height; `tone="warn"` colours the fill lemon (used when a limit is reached); `variant="journey"` is the
 * launch-journey bar (its own gradient, shine and transform, kept as it was). No hooks and no directive.
 */
export type ProgressProps = {
  value: number;
  max: number;
  /** The accessible name: what is being measured. Required: a bar with no name says nothing. */
  label: string;
  /** Spoken in place of the bare number, e.g. "3 of 5 seats". */
  valueText?: string;
  size?: "sm" | "md";
  tone?: "default" | "warn";
  variant?: "bar" | "journey";
  /** Smallest fill shown, in percent, so a started bar is never empty (the journey bar uses 4). */
  minFill?: number;
  /** Track colour class for the `bar` variant. */
  trackClassName?: string;
  className?: string;
};

export default function Progress({ value, max, label, valueText, size = "md", tone = "default", variant = "bar", minFill = 0, trackClassName = "bg-background-muted", className = "" }: ProgressProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const now = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), safeMax);
  const pct = Math.max(minFill, percent(now, safeMax));
  const aria = { role: "progressbar" as const, "aria-valuemin": 0, "aria-valuemax": safeMax, "aria-valuenow": now, "aria-valuetext": valueText, "aria-label": label };
  if (variant === "journey") {
    return (
      <div className={`journey-track ${className}`.trim()} {...aria}>
        <div className="journey-fill" style={{ "--p": pct / 100 } as React.CSSProperties} />
      </div>
    );
  }
  return (
    <div className={`${size === "sm" ? "h-1.5" : "h-2"} overflow-hidden rounded-full ${trackClassName} ${className}`.trim()} {...aria}>
      <div className={`h-full rounded-full ${tone === "warn" ? "bg-lemon" : "bg-foreground"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
