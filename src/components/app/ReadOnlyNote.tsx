import { Icon } from "./Icons";

/**
 * The one-line note a lower role sees on a screen they can read but not change (docs/superpowers/specs/2026-09-29-teams-design.md §7).
 * Display only: every write behind these screens is refused by the server for the same roles (src/lib/roles.ts).
 * No hooks, so server and client components can both render it.
 */
export default function ReadOnlyNote({ text, className = "mt-3" }: { text: string; className?: string }) {
  return (
    <p role="note" className={`${className} flex items-start gap-2 rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm`}>
      <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
      <span>{text}</span>
    </p>
  );
}
