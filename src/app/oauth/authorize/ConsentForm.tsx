"use client";
import { useState } from "react";

/**
 * The consent form (rule 2305). The enforced CSP says `form-action 'self'` (next.config.ts), and Chrome applies it to the
 * redirect that follows a form POST: the 303 from /api/oauth/approve to the app's redirect_uri (another origin) was
 * blocked, so connecting an MCP client never finished. The answer is asked for as JSON instead (`Accept:
 * application/json`) and the browser goes to the address with `location.assign`, a plain navigation that `form-action`
 * does not cover. The address comes from our own route, which checked it against the client's registered list; the page
 * never builds it. Without JavaScript the form still posts as before.
 */
export default function ConsentForm({ fields, allow, deny, failed }: { fields: Record<string, string>; allow: string; deny: string; failed: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function decide(e: React.MouseEvent<HTMLButtonElement>, decision: "allow" | "deny") {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    const res = await fetch("/api/oauth/approve", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...fields, decision }).toString(),
    }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { redirect?: unknown };
    if (res?.ok && typeof j.redirect === "string") { window.location.assign(j.redirect); return; }
    setBusy(false);
    setErr(failed);
  }
  return (
    <form method="post" action="/api/oauth/approve">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button name="decision" value="allow" disabled={busy} onClick={(e) => void decide(e, "allow")} style={{ flex: 1, background: "var(--color-ink)", color: "var(--color-paper)", border: 0, borderRadius: 999, padding: "12px 16px", fontWeight: 600, cursor: "pointer" }}>{allow}</button>
        <button name="decision" value="deny" disabled={busy} onClick={(e) => void decide(e, "deny")} style={{ flex: 1, background: "var(--color-paper)", color: "var(--color-ink)", border: "1.5px solid var(--color-ink)", borderRadius: 999, padding: "12px 16px", cursor: "pointer" }}>{deny}</button>
      </div>
      {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 14, marginTop: 12 }}>{err}</p>}
    </form>
  );
}
