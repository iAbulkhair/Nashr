"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import type { Integration } from "@/lib/integrations";
import type { KeyField } from "@/lib/connectors/registry";
import { READS_METRICS, isWorking } from "@/lib/connectors/working";
import type { Lang } from "@/lib/i18n";

type P = { id: string; name: string; kind: "oauth" | "key"; capabilities: string[]; available: boolean; keyFields?: KeyField[]; docs?: string; needsShop: boolean };
type C = { provider: string; meta?: Record<string, string>; connectedAt: string; needsReconnect?: string };

export default function IntegrationsPanel({ t, lang, items }: { t: AppDict; lang: Lang; items: Integration[] }) {
  const g = t.integrations;
  const r = useRouter();
  const sp = useSearchParams();
  const [providers, setProviders] = useState<P[]>([]);
  const [conns, setConns] = useState<C[]>([]);
  const [done, setDone] = useState<Record<string, number>>({});
  const [other, setOther] = useState("");
  const [keyFor, setKeyFor] = useState<P | null>(null);
  const [shopFor, setShopFor] = useState<P | null>(null);
  const [shop, setShop] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const flash = sp.get("connected") ? `${g.connected}: ${sp.get("connected")}` : sp.get("error") ? `${g.verifyFailed} (${sp.get("error")})` : "";

  async function load() {
    const j = await (await fetch("/api/connect")).json();
    if (j.ok) { setProviders(j.providers); setConns(j.connections); }
  }
  useEffect(() => { void Promise.resolve().then(load); }, []);

  async function req(id: string, name: string) {
    const res = await fetch("/api/integrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
    const j = await res.json();
    if (j.ok) setDone((d) => ({ ...d, [id]: j.votes }));
  }
  async function disconnect(id: string) {
    await fetch(`/api/connect/${id}`, { method: "DELETE" });
    await load();
    r.refresh();
  }
  async function submitKey(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!keyFor) return;
    setBusy(true); setErr("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch(`/api/connect/${keyFor.id}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    const j = await res.json();
    setBusy(false);
    if (!j.ok) return setErr(`${g.verifyFailed} ${j.detail ?? ""}`);
    setKeyFor(null);
    await load();
  }
  async function importProducts(id: string) {
    setBusy(true);
    const res = await fetch(`/api/connect/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import_products" }) });
    const j = await res.json();
    setBusy(false);
    alert(j.ok ? `${g.importProducts}: ${j.count}` : j.error);
  }
  async function selectPage(pageId: string) {
    setBusy(true);
    const res = await fetch("/api/connect/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_page", pageId }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!j.ok) alert(j.error ?? res.status);
    await load();
    r.refresh();
  }
  async function selectAdAccount(provider: string, accountId: string) {
    setBusy(true);
    const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_ad_account", accountId }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!j.ok) alert(j.error ?? res.status);
    await load();
    r.refresh();
  }
  const startOAuth = (p: P) => {
    if (p.needsShop) { setShopFor(p); return; }
    // Not an internal page: this route answers 302 to the provider's own consent screen. router.push() performs a
    // client-side RSC navigation, which cannot leave the origin, so the hand-off has to be a real navigation.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- leaves the origin via a 302
    window.location.assign(`/api/connect/${p.id}/start?lang=${lang}`);
  };

  const connectedIds = new Set(conns.map((c) => c.provider));
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const groups = ["commerce", "ads", "messaging", "publishing", "data", "payments"] as const;
  const badge = (s: string) => (s === "live" ? "bg-oasis text-mist" : s === "soon" ? "bg-saffron/20 text-ink" : "bg-ink/10 text-ink/60");

  // Map catalog ids → connector ids where they differ
  // Meta Ads and WhatsApp are not built: they keep their catalog status instead of borrowing the Meta connection's.
  const connectorId = (i: Integration) => ({ snap_ads: "snapchat", instagram: "meta", facebook: "meta", gbp: "google", ga4: "google", gsc: "google" } as Record<string, string>)[i.id] ?? i.id;

  return (
    <div>
      <h1 className="page-title">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      {flash && <p role="status" className="mt-3 rounded-lg bg-salt-dim p-3 text-sm text-oasis">{flash}</p>}
      <p className="mt-2 rounded-lg border border-saffron/40 bg-saffron/10 p-3 text-sm">{g.note}</p>

      {conns.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-oasis">{g.connected}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {conns.map((c) => (
              <div key={c.provider} className="flex items-start justify-between gap-3 rounded-xl border border-oasis/40 bg-white p-4">
                <div>
                  <p className="font-display font-medium">{providerById.get(c.provider)?.name ?? c.provider}</p>
                  <p className="mt-1 text-xs text-ink/60" dir="ltr">{c.meta?.account ?? c.meta?.shop ?? c.meta?.site ?? ""}</p>
                  <p className="mt-1 text-xs text-ink/40" dir="ltr">{c.connectedAt.slice(0, 10)}</p>
                  {c.needsReconnect && <p className="mt-1 text-xs font-semibold text-sadu">{g.reconnect}</p>}
                  {c.provider === "meta" && c.meta?.pages && (
                    <label className="mt-2 grid gap-1 text-xs text-ink/60">
                      <span>{g.metaPage}</span>
                      <select value={c.meta.pageId} disabled={busy} onChange={(e) => selectPage(e.target.value)} className="rounded border border-ink/15 bg-white px-2 py-1 text-xs" dir="auto">
                        {(JSON.parse(c.meta.pages) as { id: string; name: string; ig: string }[]).map((pg) => <option key={pg.id} value={pg.id}>{pg.ig ? `${pg.name} · @${pg.ig}` : pg.name}</option>)}
                      </select>
                    </label>
                  )}
                  {c.provider === "meta" && c.meta?.pageId && !c.meta.igId && <p className="mt-1 text-xs text-ink/60">{g.metaNoIg}</p>}
                  {READS_METRICS.includes(c.provider) && c.meta?.adAccounts && (
                    <label className="mt-2 grid gap-1 text-xs text-ink/60">
                      <span>{g.adAccount}</span>
                      <select value={c.meta.adAccount} disabled={busy} onChange={(e) => selectAdAccount(c.provider, e.target.value)} className="rounded border border-ink/15 bg-white px-2 py-1 text-xs" dir="auto">
                        {(JSON.parse(c.meta.adAccounts) as { id: string; name: string }[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {c.needsReconnect && providerById.get(c.provider)?.kind === "oauth" && <button onClick={() => startOAuth(providerById.get(c.provider)!)} className="rounded-full bg-oasis px-3 py-1 text-xs font-semibold text-mist">{g.reconnectBtn}</button>}
                  {["shopify", "woocommerce", "odoo", "prestashop", "salla"].includes(c.provider) && <button disabled={busy} onClick={() => importProducts(c.provider)} className="rounded-full border border-oasis/40 px-3 py-1 text-xs text-oasis">{g.importProducts}</button>}
                  <button onClick={() => disconnect(c.provider)} className="rounded-full border border-sadu/40 px-3 py-1 text-xs text-sadu">{g.disconnect}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.map((grp) => (
        <section key={grp} className="mt-8">
          <h2 className="eyebrow">{g.groups[grp]}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.filter((i) => i.group === grp).map((i) => {
              // A card offers "Connect" or shows "Connected" only when code uses that connection; the others keep their
              // catalog status. The Connected section above still lists every stored connection so it can be removed.
              const found = providerById.get(connectorId(i));
              // Working: publishes or imports. Reading ad results counts too (READS_METRICS).
              const p = found && (isWorking(found.id) || READS_METRICS.includes(found.id)) ? found : undefined;
              const isConnected = p ? connectedIds.has(p.id) : false;
              const canConnect = p?.available && !isConnected;
              const status = isConnected ? "live" : p?.available ? "ready" : i.status;
              return (
                <div key={i.id} className="flex items-start justify-between gap-3 card card-sm">
                  <div>
                    <p className="font-display font-medium">{i.name}</p>
                    {i.note && <p className="mt-1 text-xs text-ink/60">{i.note}</p>}
                    <span className={`mt-2 inline-block rounded px-2 py-0.5 text-xs ${badge(status === "ready" ? "soon" : status)}`}>{status === "ready" ? g.ready : status === "live" ? g.connected : status === "soon" && p?.kind === "oauth" ? g.waiting : g.status[i.status]}</span>
                  </div>
                  {canConnect ? (
                    <button onClick={() => (p!.kind === "key" ? setKeyFor(p!) : startOAuth(p!))} className="shrink-0 rounded-full bg-oasis px-3 py-1 text-xs font-semibold text-mist">{g.connect}</button>
                  ) : !isConnected ? (
                    <button onClick={() => req(i.id, i.name)} disabled={!!done[i.id]} className="shrink-0 rounded-full border border-oasis/40 px-3 py-1 text-xs text-oasis disabled:border-ink/10 disabled:text-ink/40">{done[i.id] ? `${g.requested} · ${done[i.id]}` : g.request}</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <form onSubmit={(e) => { e.preventDefault(); if (other.trim()) { req("other:" + other.trim().toLowerCase(), other.trim()); setOther(""); } }} className="mt-8 flex max-w-md gap-2">
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder={g.other} className="flex-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm" />
        <button className="rounded-lg bg-oasis px-4 py-2 text-sm font-semibold text-mist">{g.send}</button>
      </form>

      {keyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setKeyFor(null)}>
          <form onSubmit={submitKey} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl bg-white p-6">
            <h2 className="font-display text-lg font-bold text-oasis">{keyFor.name}</h2>
            <p className="mt-1 text-sm text-ink/60">{g.keyTitle}</p>
            {keyFor.docs && <p className="mt-2 rounded bg-salt-dim p-2 text-xs text-ink/70" dir="ltr">{g.keyHelp} {keyFor.docs}</p>}
            <div className="mt-4 grid gap-3">
              {keyFor.keyFields?.map((f) => (
                <label key={f.name} className="grid gap-1 text-sm">
                  <span>{lang === "ar" ? f.labelAr : f.label}</span>
                  <input name={f.name} type={f.type === "password" ? "password" : "text"} dir="ltr" placeholder={f.placeholder} required className="rounded-lg border border-ink/15 px-3 py-2" />
                </label>
              ))}
            </div>
            {err && <p className="mt-3 text-sm text-sadu">{err}</p>}
            <div className="mt-5 flex gap-2">
              <button disabled={busy} className="rounded-full bg-oasis px-5 py-2 text-sm font-semibold text-mist disabled:opacity-60">{busy ? g.verifying : g.connect}</button>
              <button type="button" onClick={() => setKeyFor(null)} className="rounded-full border border-ink/20 px-5 py-2 text-sm">✕</button>
            </div>
          </form>
        </div>
      )}
      {shopFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShopFor(null)}>
          <form onSubmit={(e) => {
            e.preventDefault();
            // Same hand-off as startOAuth: the route redirects off-origin to the provider.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- leaves the origin via a 302
            window.location.href = `/api/connect/${shopFor.id}/start?lang=${lang}&shop=${encodeURIComponent(shop)}`;
          }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl bg-white p-6">
            <h2 className="font-display text-lg font-bold text-oasis">{shopFor.name}</h2>
            <input value={shop} onChange={(e) => setShop(e.target.value)} dir="ltr" placeholder={g.shopPrompt} required className="mt-4 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            <button className="mt-4 rounded-full bg-oasis px-5 py-2 text-sm font-semibold text-mist">{g.connect}</button>
          </form>
        </div>
      )}
    </div>
  );
}
