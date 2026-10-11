import Callout from "@/components/ui/Callout";

/**
 * The one-line note a lower role sees on a screen they can read but not change (docs/superpowers/specs/2026-09-29-teams-design.md §7).
 * Display only: every write behind these screens is refused by the server for the same roles (src/lib/roles.ts).
 * The notice tone of `Callout` (rule 1087): lilac with an ink line and the padlock, where it was a lemon tint on a light
 * ground, which lemon never is. No hooks, so server and client components can both render it.
 */
export default function ReadOnlyNote({ text, className = "mt-3" }: { text: string; className?: string }) {
  return <Callout tone="notice" role="note" className={className}>{text}</Callout>;
}
