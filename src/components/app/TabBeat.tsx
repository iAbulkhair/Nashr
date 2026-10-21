"use client";
import { useEffect } from "react";
import { BEAT_SECONDS } from "@/lib/push-beat";

/**
 * "This person is here" (rule 2564): while an app tab is visible it tells the server every `BEAT_SECONDS`, and once
 * when it comes back into view, so phone notifications go only to someone away from the app. Mounted by the app layout
 * only while push is on and for a person's own session (never a founder's view of an account). Renders nothing; a
 * failed beat is ignored (the worst case is one notification while the person was looking).
 */
export default function TabBeat() {
  useEffect(() => {
    let last = 0;
    const beat = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      fetch("/api/push/seen", { method: "POST" }).catch(() => {});
    };
    beat();
    const id = setInterval(beat, BEAT_SECONDS * 1000);
    document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", beat); };
  }, []);
  return null;
}
