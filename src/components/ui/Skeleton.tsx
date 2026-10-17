/**
 * Loading shapes (rule 1115). A skeleton is decoration: hidden from screen readers, still under reduced motion. The words
 * a screen reader hears come from the `LoadingRegion` around it, a polite status that says the screen is loading and is
 * `aria-busy` until the content replaces it. No hooks and no directive: `loading.tsx` files and server pages use them.
 */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block ${className}`} />;
}

/** Lines of text, the last one shorter, as a paragraph would end. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={`grid gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => <span key={i} className={`skeleton block h-3.5 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />)}
    </span>
  );
}

/**
 * A panel's own data on its way (rule 2003): the shapes of what will replace them, inside one polite status, in place of
 * a bare "Loading…" line or a blank box. `rows` are list rows, `cards` are titled cards, `line` is one short line for a
 * small card. The words come from the panel's dictionary, so each panel names what it is loading.
 */
export function PanelSkeleton({ label, shape = "rows", count = 3, className = "" }: { label: string; shape?: "rows" | "cards" | "line"; count?: number; className?: string }) {
  return (
    <LoadingRegion label={label} className={className}>
      {shape === "line" ? (
        <Skeleton className="h-4 w-2/3" />
      ) : shape === "cards" ? (
        <span className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: count }, (_, i) => <span key={i} className="grid gap-3 rounded-card border border-border p-4"><Skeleton className="h-5 w-1/2" /><SkeletonText lines={2} /></span>)}
        </span>
      ) : (
        <span className="grid gap-2">{Array.from({ length: count }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</span>
      )}
    </LoadingRegion>
  );
}

/** The live region a loading screen sits in: one polite announcement, then the shapes. */
export function LoadingRegion({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
