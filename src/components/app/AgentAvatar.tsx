import Scribble from "@/components/Scribble";
import type { AgentId } from "@/lib/agents";

/** Faris and Majed are dark fills, so their initial is paper; every other agent's is ink. */
const ON_DARK: ReadonlySet<AgentId> = new Set(["faris", "majed"]);

/**
 * An agent's avatar in the app (rule 519): the initial on the agent's own colour inside a hand-drawn ring. The colour
 * is a fill, never text (rule 517). Decorative: the name is always written next to it.
 */
export default function AgentAvatar({ id, name, className = "h-8 w-8 text-sm" }: { id: AgentId; name: string; className?: string }) {
  return (
    <span data-scribble className={`grid shrink-0 place-items-center font-display font-bold ${ON_DARK.has(id) ? "text-inverse-foreground" : "text-accent-foreground"} ${className}`} aria-hidden="true">
      <Scribble kind="circleLoop" seed={`avatar-${id}`} fill={`agent-${id}`} />
      {name.charAt(0)}
    </span>
  );
}
