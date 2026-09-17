"use client";
import { useEffect, useState } from "react";

type U = { email: string; name: string; phone: string; plan: string; credits: number; trialEnds: string; createdAt: string };
type T = { id: string; type: string; channel: string; title: string; status: string; createdAt: string; body: string; editedBody?: string };

export default function AdminConsole() {
  const [users, setUsers] = useState<U[] | null>(null);
  const [sel, setSel] = useState<{ user: U; brand: Record<string, unknown> | null; tasks: T[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await fetch("/api/admin/plan");
    if (r.status === 401) return setUsers([]);
    const j = await r.json();
    setUsers(j.users);
  }
  useEffect(() => { load(); }, []);

  async function setPlan(email: string, plan: string) {
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, plan }) });
    setMsg(`${email} → ${plan}`);
    await load();
    setBusy(false);
  }
  async function addCredits(email: string) {
    const n = Number(prompt("Credits to add (negative to remove):", "100"));
    if (!n) return;
    setBusy(true);
    await fetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, addCredits: n }) });
    setMsg(`${email} +${n} credits`);
    await load();
    setBusy(false);
  }
  async function open(email: string) {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`);
    const j = await r.json();
    if (j.ok) setSel(j);
  }

  if (users === null) return <p className="text-ink/60">Loading…</p>;
  const paying = users.filter((u) => u.plan !== "trial").length;
  const today = users.filter((u) => u.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

  return (
    <div dir="ltr" className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {[["Users", users.length], ["Paying", paying], ["Signed up today", today], ["Trial", users.length - paying]].map(([l, v]) => (
          <div key={String(l)} className="rounded-xl border border-ink/10 bg-white p-4"><p className="text-xs text-ink/60">{l}</p><p className="font-display text-2xl font-bold text-oasis">{v}</p></div>
        ))}
      </div>
      {msg && <p className="text-sm text-oasis">{msg}</p>}
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-salt-dim text-left text-xs uppercase tracking-wide text-ink/60">
            <tr><th className="p-3">Email</th><th>Name</th><th>Phone</th><th>Plan</th><th>Credits</th><th>Trial ends</th><th>Joined</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email} className="border-t border-ink/5">
                <td className="p-3"><button onClick={() => open(u.email)} className="text-oasis underline">{u.email}</button></td>
                <td>{u.name}</td>
                <td className="font-mono text-xs"><a href={`https://wa.me/${u.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="underline">{u.phone}</a></td>
                <td>
                  <select value={u.plan} disabled={busy} onChange={(e) => setPlan(u.email, e.target.value)} className="rounded border border-ink/15 bg-white px-2 py-1">
                    {["trial", "starter", "pro", "agency", "enterprise"].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td className="font-mono">{u.credits}</td>
                <td className="font-mono text-xs">{u.plan === "trial" ? u.trialEnds.slice(0, 10) : "—"}</td>
                <td className="font-mono text-xs">{u.createdAt.slice(0, 10)}</td>
                <td className="p-3"><button disabled={busy} onClick={() => addCredits(u.email)} className="rounded-full border border-ink/20 px-3 py-1 text-xs">+ credits</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink/50">Changing the plan adds that plan&apos;s monthly credits on top of the current balance. Use &quot;+ credits&quot; for top-ups or corrections.</p>

      {sel && (
        <div className="rounded-xl border border-oasis/30 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-oasis">{sel.user.email}</h2>
            <button onClick={() => setSel(null)} className="text-sm text-ink/60">close</button>
          </div>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-ink/60">Brand file</h3>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-salt-dim p-3 text-xs" dir="auto">{sel.brand ? JSON.stringify(sel.brand, null, 2) : "— not completed —"}</pre>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-ink/60">Generated items ({sel.tasks.length}) — approved {sel.tasks.filter((t) => t.status === "approved").length}, rejected {sel.tasks.filter((t) => t.status === "rejected").length}</h3>
          <ul className="mt-2 grid max-h-96 gap-2 overflow-auto">
            {sel.tasks.map((t) => (
              <li key={t.id} className="rounded border border-ink/10 p-3 text-xs">
                <div className="flex justify-between text-ink/60"><span>{t.type} · {t.channel} · {t.status}</span><span>{t.createdAt.slice(0, 16).replace("T", " ")}</span></div>
                <p className="mt-1 whitespace-pre-wrap" dir="auto">{(t.editedBody ?? t.body).slice(0, 600)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
