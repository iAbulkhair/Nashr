"use client";
import { useEffect, useRef } from "react";

/**
 * The Cloudflare Turnstile widget (src/lib/turnstile.ts). Rendered only when the server page passes a site key, i.e.
 * when both Turnstile keys are set (the secret one never leaves the server). Explicit rendering: the script is added
 * once per page and the widget hands its token to `onToken` ("" when it expires or errors). A token is single use, so
 * the form bumps `resetKey` after every refused submit and the widget issues a new one.
 */
type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing")));
    s.onerror = () => { loading = null; s.remove(); reject(new Error("turnstile_load_failed")); };
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken, resetKey, lang }: { siteKey: string; onToken: (token: string) => void; resetKey: number; lang: "ar" | "en" }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  // The latest callback, so the widget never needs to be rendered again when the parent re-renders.
  const cb = useRef(onToken);
  useEffect(() => { cb.current = onToken; }, [onToken]);

  useEffect(() => {
    let gone = false;
    loadTurnstile().then((api) => {
      if (gone || !box.current || id.current) return;
      id.current = api.render(box.current, {
        sitekey: siteKey,
        language: lang,
        callback: (t: string) => cb.current(t),
        "expired-callback": () => cb.current(""),
        "error-callback": () => cb.current(""),
      });
    }).catch(() => cb.current(""));
    return () => {
      gone = true;
      if (id.current && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [siteKey, lang]);

  useEffect(() => {
    if (resetKey > 0 && id.current && window.turnstile) {
      window.turnstile.reset(id.current);
      cb.current("");
    }
  }, [resetKey]);

  return <div ref={box} className="min-h-[65px]" />;
}
