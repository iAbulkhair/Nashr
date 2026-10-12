"use client";
import { useParams } from "next/navigation";
import { Skeleton, SkeletonText, LoadingRegion } from "@/components/ui/Skeleton";

/** The shapes a screen loads in, close to the screen that replaces them, so nothing jumps when it arrives. */
export type LoadingKind = "page" | "list" | "chat" | "calendar" | "reports";

const LABEL = { ar: "تُحمَّل الصفحة…", en: "Loading the page…" } as const;

/**
 * What a `loading.tsx` shows while the server renders a screen (rule 1115). `loading.tsx` receives no params, so the
 * language comes from the URL here; the words are one polite status ("Loading the page…") and the shapes are hidden from
 * screen readers. The sidebar stays where it is: the layout persists across navigations, only this area waits.
 */
export default function RouteLoading({ kind = "page" }: { kind?: LoadingKind }) {
  const p = useParams<{ lang?: string }>();
  const lang = p?.lang === "en" ? "en" : "ar";
  return (
    <LoadingRegion label={LABEL[lang]} className="grid gap-5">
      <div className="grid gap-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-72 max-w-full" /></div>
      {kind === "chat" ? (
        <div className="grid flex-1 gap-4">
          <Skeleton className="h-16 w-3/4 rounded-2xl" />
          <Skeleton className="ms-auto h-10 w-1/2 rounded-2xl" />
          <Skeleton className="h-24 w-4/5 rounded-2xl" />
          <Skeleton className="mt-4 h-12 w-full rounded-2xl" />
        </div>
      ) : kind === "calendar" ? (
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 14 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
        </div>
      ) : kind === "reports" ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 w-full rounded-card" />)}</div>
          <Skeleton className="h-56 w-full rounded-card" />
        </>
      ) : kind === "list" ? (
        <div className="grid gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="card grid gap-3 p-4"><Skeleton className="h-5 w-1/2" /><SkeletonText lines={3} /></div>)}
        </div>
      )}
    </LoadingRegion>
  );
}
