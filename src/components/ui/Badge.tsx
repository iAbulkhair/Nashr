/**
 * A short status label (rule 1086). The words say the status; the tone only backs them up, so a badge is never colour
 * alone. Tones: neutral (a plain fact), info (lilac), success, warning and danger (tint fills with 4.5:1 text), inverse
 * (paper on ink, for "active" and "current"). There is no lemon tone: lemon reads only on ink. No hooks, so server
 * components use it too.
 */
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "inverse";

const TONE: Record<BadgeTone, string> = {
  neutral: "badge-neutral",
  info: "badge-primary",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  inverse: "badge-inverse",
};

export default function Badge({ tone = "neutral", className = "", children, ...rest }: React.ComponentProps<"span"> & { tone?: BadgeTone }) {
  return <span {...rest} className={`badge ${TONE[tone]} ${className}`.trim()}>{children}</span>;
}
