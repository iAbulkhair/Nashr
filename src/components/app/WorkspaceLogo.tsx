"use client";

import { useState } from "react";
import { initialOf } from "./PersonAvatar";

/**
 * A workspace's logo, or its initial (rule 3610). The logo is our own signed `/api/logo/` URL; when there is none or it
 * fails to load (removed since, signed out), the first letter of the workspace's name shows on a tile instead. A
 * rounded square, not a circle, so it never reads as a person. Decorative: the name is always next to it. Never
 * mirrored in RTL (a logo is an image, not a direction).
 */
export default function WorkspaceLogo({ src, name, size = 36, className = "" }: { src?: string | null; name?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src ? src : null;
  const box = { width: size, height: size };
  if (show) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- our own private /api/logo/ route, served with the session
      <img src={show} alt="" aria-hidden width={size} height={size} style={box} decoding="async" onError={() => setFailed(show)} className={`shrink-0 rounded-lg bg-background-muted object-contain ${className}`} />
    );
  }
  return (
    <span aria-hidden style={box} className={`grid shrink-0 place-items-center rounded-lg bg-background-muted font-semibold ${className}`}>
      {initialOf(name)}
    </span>
  );
}
