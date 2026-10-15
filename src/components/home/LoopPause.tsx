"use client";
import { useEffect } from "react";

/**
 * Holds the home page's endless decoration while it is off screen (rule 1868): every element marked `data-loop`
 * (`Decor.tsx`) gets `data-away` while none of it is on screen, and home.module.css pauses the animations under it.
 * The attribute is written straight onto the element, so scrolling re-renders nothing. Renders nothing itself.
 */
export default function LoopPause() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.target.toggleAttribute("data-away", !e.isIntersecting);
      },
      { rootMargin: "120px 0px" },
    );
    document.querySelectorAll("[data-loop]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
  return null;
}
