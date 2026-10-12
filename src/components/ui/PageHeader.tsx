import ScribbleStatic from "@/components/ScribbleStatic";

/**
 * A screen's heading row (rule 1114): the title with its hand-drawn underline, an optional line under it and the screen's
 * actions at the inline end, wrapping under the title on a phone. No `"use client"`: the underline is `ScribbleStatic`,
 * drawn on the server in the page's direction, so a server page renders the whole header without JavaScript and an Arabic
 * underline never flips at hydration. A client panel can render it too.
 */
export default function PageHeader({ lang, title, sub, actions, seed, className = "" }: {
  lang: "ar" | "en";
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** The underline's stable shape: the screen's name. */
  seed: string;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-x-4 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="page-title"><span className="s-ul"><ScribbleStatic kind="underline" seed={seed} rtl={lang === "ar"} />{title}</span></h1>
        {sub && <p className="page-sub max-w-prose">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
