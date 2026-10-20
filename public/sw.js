/*
 * Thakeen phone notifications (rules 2565-2569, src/lib/push.ts). Registered only by src/components/app/PushToggle.tsx
 * after the person asks for notifications. It handles push and notification clicks and nothing else: no fetch
 * handler and no Cache API, so every page is still only what the server sends (rule 683 as narrowed by rule 2569).
 *
 * A push carries no data. The worker asks /api/push/latest with this device's own session for the text (app name,
 * one agent's name and state) and shows a generic line when that fails. A 401 means the device has no session any
 * more, so it unsubscribes itself.
 */
const FALLBACK = { title: "ذكين | Thakeen", body: "لديك تحديث من فريقك في ذكين. You have an update from your Thakeen team.", href: "/app" };

async function latest() {
  try {
    const res = await fetch("/api/push/latest", { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      return FALLBACK;
    }
    if (!res.ok) return FALLBACK;
    const j = await res.json();
    const href = typeof j.href === "string" && j.href.startsWith("/") && !j.href.startsWith("//") ? j.href : FALLBACK.href;
    return { title: String(j.title || FALLBACK.title), body: String(j.body || FALLBACK.body), href };
  } catch {
    return FALLBACK;
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    latest().then((n) =>
      self.registration.showNotification(n.title, { body: n.body, tag: "thakeen-team", icon: "/icons/icon-192.png", data: { href: n.href } }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || FALLBACK.href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const url = new URL(href, self.location.origin).href;
      for (const w of wins) if (w.url === url && "focus" in w) return w.focus();
      return self.clients.openWindow(url);
    }),
  );
});

/* The push service rotated this device's address: subscribe again with the same key and tell the server. */
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) =>
      fetch("/api/push", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }),
    ).catch(() => {}),
  );
});
