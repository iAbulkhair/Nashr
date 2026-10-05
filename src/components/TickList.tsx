import Scribble from "@/components/Scribble";

/** A list whose bullets are hand-drawn ticks (rule 518), as on the pricing cards. */
export default function TickList({ items, seed, className = "" }: { items: readonly string[]; seed: string; className?: string }) {
  return (
    <ul className={`space-y-3 ${className}`} role="list">
      {items.map((x, i) => (
        <li key={x} className="flex items-start gap-2.5">
          <i className="relative isolate mt-1 inline-block h-[18px] w-5 flex-none" aria-hidden="true">
            <Scribble kind="tick" seed={`${seed}-${i}`} />
          </i>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}
