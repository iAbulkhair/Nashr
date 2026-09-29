import type { Connection } from "./store";

export async function postToX(c: Connection, text: string): Promise<{ url: string; id: string }> {
  // Bounded inside the publish route's 60 s: a timeout is reported as "result unknown" (publish-once.ts), never a kill.
  const r = await fetch("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${c.data.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 280) }), signal: AbortSignal.timeout(45_000) });
  if (!r.ok) {
    const text = await r.text();
    // X answers a repeated post with 403 "duplicate content". That is a refusal of this text, not of the token: without
    // its own code it read as a revoked connection (refusedToken) and disconnected X.
    if (r.status === 403 && /duplicate/i.test(text)) throw new Error("x_duplicate");
    throw new Error(`x ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { data: { id: string } };
  return { id: j.data.id, url: `https://x.com/i/status/${j.data.id}` };
}
export async function xMe(c: Connection) {
  const r = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${c.data.access_token}` } });
  if (!r.ok) return null;
  const j = (await r.json()) as { data: { username: string; name: string } };
  return j.data;
}
