"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { STATUS_COPY } from "@/lib/agent-status";

type Phase = "unsupported" | "off" | "on" | "busy" | "denied" | "failed";

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` wants. */
function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const send = (method: "POST" | "DELETE", endpoint: string) =>
  fetch("/api/push", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });

/**
 * "Notify me on this device" (rules 2562-2563, 2570). Rendered only while push is on (the page passes the public key);
 * hidden where the browser has no Web Push (an iPhone outside the installed app, an in-app browser). The permission is
 * asked only after this button is pressed, the worker (public/sw.js) is registered only then, and the device is stored
 * by POST /api/push. Switching off removes it from the server first, then from the browser.
 */
export default function PushToggle({ lang, publicKey }: { lang: Lang; publicKey: string }) {
  const c = STATUS_COPY[lang];
  const [phase, setPhase] = useState<Phase>("unsupported");

  useEffect(() => {
    if (!supported()) return;
    let live = true;
    (async () => {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (live) setPhase(Notification.permission === "denied" ? "denied" : sub ? "on" : "off");
    })().catch(() => { if (live) setPhase("off"); });
    return () => { live = false; };
  }, []);

  if (phase === "unsupported") return null;

  const enable = async () => {
    setPhase("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setPhase(perm === "denied" ? "denied" : "off");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const res = await send("POST", sub.endpoint);
      if (!res.ok) { await sub.unsubscribe().catch(() => {}); return setPhase("failed"); }
      setPhase("on");
    } catch {
      setPhase("failed");
    }
  };

  const disable = async () => {
    setPhase("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await send("DELETE", sub.endpoint).catch(() => null);
        await sub.unsubscribe();
      }
      setPhase("off");
    } catch {
      setPhase("failed");
    }
  };

  if (phase === "denied") return <p className="text-xs text-foreground-muted">{c.pushDenied}</p>;
  const on = phase === "on";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={on ? disable : enable} disabled={phase === "busy"} aria-busy={phase === "busy"} className="btn btn-secondary btn-pill">
        {on ? c.pushOff : c.pushOn}
      </button>
      <span className="text-foreground-muted" role={phase === "failed" ? "alert" : undefined}>{phase === "failed" ? c.pushFailed : c.pushNote}</span>
    </div>
  );
}
