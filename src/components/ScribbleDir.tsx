"use client";
import { createContext, type ReactNode } from "react";

/**
 * The page's reading direction for the client scribbles (rule 1869). The language layout sets it from `lang`, so a
 * `Scribble` without its own `rtl` is drawn the right way round on the server and in the first client render, instead
 * of starting left-to-right and flipping once it has measured its parent.
 */
export const ScribbleDirContext = createContext<boolean | undefined>(undefined);

export default function ScribbleDir({ rtl, children }: { rtl: boolean; children: ReactNode }) {
  return <ScribbleDirContext.Provider value={rtl}>{children}</ScribbleDirContext.Provider>;
}
