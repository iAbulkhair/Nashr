import ScribbleStatic from "@/components/ScribbleStatic";

/**
 * A list whose bullets are hand-drawn ticks (rule 518), as on the pricing cards. The tick has a fixed size, so it is
 * drawn on the server (rule 1863) and mirrored for Arabic with `rtl`.
 */
export default function TickList({ items, seed, rtl, className = "" }: { items: readonly string[]; seed: string; rtl: boolean; className?: string }) {
  return (
    <ul className={`space-y-3 ${className}`} role="list">
      {items.map((x, i) => (
        <li key={x} className="flex items-start gap-2.5">
          <i className="relative isolate mt-1 inline-block h-[18px] w-5 flex-none" aria-hidden="true">
            <ScribbleStatic kind="tick" seed={`${seed}-${i}`} rtl={rtl} />
          </i>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}
