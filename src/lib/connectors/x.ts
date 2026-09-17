import type { Connection } from "./store";

export async function postToX(c: Connection, text: string): Promise<{ url: string; id: string }> {
  const r = await fetch("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${c.data.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 280) }) });
  if (!r.ok) throw new Error(`x ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { data: { id: string } };
  return { id: j.data.id, url: `https://x.com/i/status/${j.data.id}` };
}
export async function xMe(c: Connection) {
  const r = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${c.data.access_token}` } });
  if (!r.ok) return null;
  const j = (await r.json()) as { data: { username: string; name: string } };
  return j.data;
}
