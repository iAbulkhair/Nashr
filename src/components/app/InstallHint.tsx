"use client";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { INSTALL_COPY, dismissHint, hintDismissed, installWay, type InstallWay } from "@/lib/pwa";

/** Chrome's install event; not in the DOM typings. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const store = (): Storage | undefined => { try { return window.localStorage; } catch { return undefined; } };

/**
 * "Add to home screen" strip in the signed-in app shell (rule 684). iPhone and iPad Safari get the Share-menu steps;
 * browsers that fire `beforeinstallprompt` (Chrome, Edge, Android) get an Install button that opens their own dialog.
 * Hidden when already installed, after an install, and for good once dismissed in this browser (localStorage, try/catch).
 */
export default function InstallHint({ lang }: { lang: Lang }) {
  const [way, setWay] = useState<InstallWay>("none");
  const event = useRef<InstallEvent | null>(null);
  const c = INSTALL_COPY[lang];

  useEffect(() => {
    const ctx = () => ({
      standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      touchPoints: navigator.maxTouchPoints,
    });
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep the browser's own mini bar away; the strip's button opens the dialog instead
      event.current = e as InstallEvent;
      if (!hintDismissed(store())) setWay(installWay(navigator.userAgent, { ...ctx(), hasPrompt: true }));
    };
    const onInstalled = () => { event.current = null; setWay("none"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    // Read after the first paint (storage and the user agent are outside React); iOS has no event to wait for.
    const id = setTimeout(() => {
      if (!hintDismissed(store()) && !event.current) setWay(installWay(navigator.userAgent, { ...ctx(), hasPrompt: false }));
    }, 800);
    return () => {
      clearTimeout(id);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (way === "none") return null;

  const hide = () => { dismissHint(store()); setWay("none"); };
  const install = async () => {
    const e = event.current;
    if (!e) return;
    event.current = null; // an install event prompts once
    await e.prompt();
    const { outcome } = await e.userChoice;
    if (outcome === "dismissed") hide();
    else setWay("none");
  };

  const ios = way === "ios";
  const title = ios ? c.iosTitle : c.promptTitle;
  return (
    <section aria-label={title} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border-[1.5px] border-border-strong bg-surface px-4 py-3 text-sm text-foreground">
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 text-foreground-muted">{ios ? c.iosBody : c.promptBody}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!ios && <button type="button" onClick={install} className="btn btn-primary btn-pill">{c.install}</button>}
        <button type="button" onClick={hide} className="btn btn-secondary btn-pill">{c.later}</button>
      </div>
    </section>
  );
}
