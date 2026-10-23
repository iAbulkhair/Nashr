"use client";

import { useState } from "react";

/** The first letter of a name, else of the address: what a person without a picture shows (rule 3502). */
export const initialOf = (name: string | undefined, email?: string) => ((name || email || "?").trim().charAt(0) || "?").toUpperCase();

/**
 * A person's picture, or their initial (rule 3502). The picture is our own signed `/api/avatar/` URL; when it is missing
 * or fails to load (removed since, signed out), the initial shows instead. Decorative: the name is always next to it.
 */
export default function PersonAvatar({ src, name, email, size = 32, className = "" }: { src?: string | null; name?: string; email?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src ? src : null;
  const box = { width: size, height: size };
  if (show) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- our own private /api/avatar/ route, served with the session
      <img src={show} alt="" aria-hidden width={size} height={size} style={box} decoding="async" onError={() => setFailed(show)} className={`shrink-0 rounded-full bg-background-muted object-cover ${className}`} />
    );
  }
  return (
    <span aria-hidden style={box} className={`grid shrink-0 place-items-center rounded-full bg-background-muted font-semibold ${className}`}>
      {initialOf(name, email)}
    </span>
  );
}
