"use client";
import HelpLink from "@/components/ui/HelpLink";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import type { Integration } from "@/lib/integrations";
import type { KeyField } from "@/lib/connectors/registry";
import { DRIVES, IMPORTS_PRODUCTS, READS_ADS, READS_REFERENCES, isWorking } from "@/lib/connectors/working";
import type { Lang } from "@/lib/i18n";
import { connectError } from "@/lib/connect-errors";
import { SALES_PROVIDERS } from "@/lib/connectors/sales";
import ReadOnlyNote from "./ReadOnlyNote";
import Scribble from "@/components/Scribble";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "./ConfirmDialog";
import { apiHref } from "@/lib/brand-fetch";

type P = { id: string; name: string; kind: "oauth" | "key"; capabilities: string[]; available: boolean; keyFields?: KeyField[]; docs?: string; needsShop: boolean; toolkits?: string[] };
type C = { provider: string; meta?: Record<string, string>; connectedAt: string; needsReconnect?: string };

/**
 * The note after a Meta Page choice (`select_page`) or a LinkedIn company page choice (`select_org`): a new page is read
 * at once only while the workspace's hourly reads last (rules 735, 739), so a saved choice whose read waits says so; any
 * other answer leaves no note.
 */
export function pageNote(g: Pick<AppDict["integrations"], "readLater">, j: { ok?: boolean; read?: boolean }): string {
  return j.ok && j.read === false ? g.readLater : "";
}

/**
 * `manage` (owner, admin): connect, reconnect, disconnect, keys, page and ad-account choice, product import. Everyone
 * else sees the connections read-only and can still ask for an integration. Display only: the routes enforce it.
 */
/** `help` is the help answer about connecting (rule 2147), from `helpHref`. */
export default function IntegrationsPanel({ t, lang, items, manage = true, help }: { t: AppDict; lang: Lang; items: Integration[]; manage?: boolean; help?: string }) {
  const g = t.integrations;
  const r = useRouter();
  const sp = useSearchParams();
  const [providers, setProviders] = useState<P[]>([]);
  const [conns, setConns] = useState<C[]>([]);
  const [done, setDone] = useState<Record<string, number>>({});
  const [other, setOther] = useState("");
  const [keyFor, setKeyFor] = useState<P | null>(null);
  const [shopFor, setShopFor] = useState<P | null>(null);
  const [busy, setBusy] = useState(false);
  // A failed action's message (rule 976), shown on the page instead of `alert()`, from the code the route answered.
  // A finished action's note is a toast (rule 1088); a failure stays on the page until the next action.
  const [actErr, setActErr] = useState("");
  const toast = useToast();
  const [ask, confirmDialog] = useConfirm();
  const fail = (code: unknown) => setActErr(connectError(lang, code));
  const cancelWord = lang === "ar" ? "تراجع" : "Cancel";
  // Back from a provider: `?connected=` names it, `?error=` is a code mapped to a message, never shown raw.
  const connectedId = sp.get("connected");
  const errorCode = sp.get("error");
  const flash = connectedId ? `${g.connected}: ${providers.find((p) => p.id === connectedId)?.name ?? connectedId}` : "";
  const flashErr = !connectedId && errorCode !== null ? connectError(lang, errorCode) : "";

  async function load() {
    // Rule 2973: a dropped connection or an HTML 502 must not reject (an unhandled rejection after a successful action).
    const res = await fetch("/api/connect").catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (j?.ok) { setProviders(j.providers); setConns(j.connections); }
  }
  useEffect(() => { void Promise.resolve().then(load); }, []);

  async function req(id: string, name: string) {
    const res = await fetch("/api/integrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
    const j = await res.json();
    if (j.ok) setDone((d) => ({ ...d, [id]: j.votes }));
  }
  // Disconnecting stops publishing and reading through that platform, so it asks first (rule 1089). A refusal from the
  // route (`revoke_failed`, `forbidden`) shows on the page instead of passing silently.
  async function disconnect(id: string) {
    const name = providerById.get(id)?.name ?? id;
    const ar = lang === "ar";
    const ok = await ask({
      title: ar ? `فصل ${name}؟` : `Disconnect ${name}?`,
      // A store's sales totals go with it (rule 2206), so the owner is told before saying yes.
      message: (SALES_PROVIDERS as readonly string[]).includes(id)
        ? (ar ? "تتوقف القراءة عبر هذا الربط، وتُحذف أرقام مبيعات المتجر من التقارير حتى تربطه من جديد وتزامن." : "Reading through this connection stops, and the store's sales totals leave your reports until you connect it again and sync.")
        : (ar ? "يتوقف النشر والقراءة عبر هذا الربط حتى تربطه من جديد." : "Publishing and reading through this connection stop until you connect it again."),
      confirmLabel: g.disconnect,
      cancelLabel: cancelWord,
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/connect/${id}`, { method: "DELETE" }).catch(() => null);
      const j = res ? ((await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }) : {};
      if (j.ok) setActErr(""); else fail(j.error);
      await load();
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  /** The key dialog's submit: nothing when connected (the dialog closes), else words for the refusal, never the provider's raw reply. */
  async function submitKey(data: FormData): Promise<string | null> {
    if (!keyFor) return null;
    const res = await fetch(`/api/connect/${keyFor.id}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) }).catch(() => null);
    const j = res ? ((await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }) : {};
    if (!j.ok) return j.error === "verify_failed" ? g.verifyFailed : connectError(lang, j.error);
    toast.success(`${g.connected}: ${keyFor.name}`);
    await load();
    return null;
  }
  // Rule 2973: each action clears `busy` in `finally` and reads the reply with `.catch(() => null)`, so a dropped connection
  // or an HTML 502 shows the generic line (`fail(undefined)`) instead of leaving every button disabled (as `disconnect`).
  async function post(url: string, body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; count?: number; read?: boolean }> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    return res ? ((await res.json().catch(() => null)) ?? {}) : {};
  }
  async function importProducts(id: string) {
    setBusy(true);
    try {
      const j = await post(`/api/connect/${id}`, { action: "import_products" });
      if (j.ok) { setActErr(""); toast.success(`${g.importProducts}: ${j.count}`); } else fail(j.error);
    } finally {
      setBusy(false);
    }
  }
  async function selectPage(pageId: string) {
    setBusy(true);
    try {
      const j = await post("/api/connect/meta", { action: "select_page", pageId });
      if (!j.ok) fail(j.error);
      else { setActErr(""); const n = pageNote(g, j); if (n) toast.info(n); }
      await load();
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function selectOrg(org: string) {
    setBusy(true);
    try {
      const j = await post("/api/connect/linkedin", { action: "select_org", org });
      if (!j.ok) fail(j.error);
      else { setActErr(""); const n = pageNote(g, j); if (n) toast.info(n); }
      await load();
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function postAs(value: "me" | "org") {
    setBusy(true);
    try {
      const j = await post("/api/connect/linkedin", { action: "post_as", value });
      if (!j.ok) fail(j.error);
      else setActErr("");
      await load();
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function selectAdAccount(provider: string, accountId: string) {
    setBusy(true);
    try {
      const j = await post(`/api/connect/${provider}`, { action: "select_ad_account", accountId });
      if (!j.ok) fail(j.error);
      else setActErr("");
      await load();
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  // `toolkit`: which account of a provider connected in parts (Meta's Instagram and Facebook) this flow connects.
  const startOAuth = (p: P, toolkit?: string) => {
    if (p.needsShop) { setShopFor(p); return; }
    // Not an internal page: this route answers 302 to the provider's own consent screen. router.push() performs a
    // client-side RSC navigation, which cannot leave the origin, so the hand-off has to be a real navigation.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- leaves the origin via a 302
    window.location.assign(apiHref(`/api/connect/${p.id}/start?lang=${lang}${toolkit ? `&toolkit=${encodeURIComponent(toolkit)}` : ""}`));
  };
  // A provider connected in parts shows each part's card as connected only when that part is: Instagram by its account,
  // Facebook by its Page.
  const PART_MARK: Record<string, string> = { instagram: "igId", facebook: "pageId", googledocs: "docs", googlesheets: "sheets" };
  const partLabel: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", googledocs: "Google Docs", googlesheets: "Google Sheets" };

  const connectedIds = new Set(conns.map((c) => c.provider));
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const groups = ["commerce", "ads", "messaging", "publishing", "data", "payments"] as const;
  // Live is lilac on ink; ready and coming soon are lilac, never lemon on a light card (rule 1086); planned is neutral.
  const tone = (s: string): BadgeTone => (s === "live" ? "inverse" : s === "soon" ? "info" : "neutral");

  // Map catalog ids → connector ids where they differ
  // Meta Ads and WhatsApp are not built: they keep their catalog status instead of borrowing the Meta connection's.
  const connectorId = (i: Integration) => ({ snap_ads: "snapchat", instagram: "meta", facebook: "meta", gbp: "google", ga4: "google", gsc: "google", googledocs: "google_workspace", googlesheets: "google_workspace" } as Record<string, string>)[i.id] ?? i.id;

  return (
    <div>
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="integrationspanel-t1" />{g.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{g.sub}</p>
      {help && <p className="mt-1"><HelpLink lang={lang} href={help} /></p>}
      {flash && <Callout tone="success" className="mt-3">{flash}</Callout>}
      {(actErr || flashErr) && <Callout tone="danger" className="mt-3">{actErr || flashErr}</Callout>}
      <Callout tone="info" role="note" className="mt-2">{g.note}</Callout>
      {confirmDialog}
      {!manage && <ReadOnlyNote className="mt-2" text={t.readOnly.admin} />}

      {conns.length > 0 && (
        <section className="mt-6">
          <h2 className="eyebrow">{g.connected}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {conns.map((c) => (
              <div key={c.provider} className="flex items-start justify-between gap-3 rounded-xl border border-foreground/40 bg-surface p-4">
                <div>
                  <p className="font-display font-medium">{providerById.get(c.provider)?.name ?? c.provider}</p>
                  <p className="mt-1 text-xs text-foreground-muted" dir="ltr">{c.meta?.account ?? c.meta?.shop ?? c.meta?.site ?? ""}</p>
                  <p className="mt-1 text-xs text-foreground-muted"><Time value={c.connectedAt} lang={lang} /></p>
                  {c.needsReconnect && <Badge tone="warning" className="mt-1">{g.reconnect}</Badge>}
                  {c.provider === "meta" && c.meta?.pages && (
                    <label className="mt-2 grid gap-1 text-xs text-foreground-muted">
                      <span>{g.metaPage}</span>
                      <select value={c.meta.pageId} disabled={busy || !manage} onChange={(e) => selectPage(e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-xs" dir="auto">
                        {(JSON.parse(c.meta.pages) as { id: string; name: string; ig: string }[]).map((pg) => <option key={pg.id} value={pg.id}>{pg.ig ? `${pg.name} · @${pg.ig}` : pg.name}</option>)}
                      </select>
                    </label>
                  )}
                  {c.provider === "linkedin" && c.meta?.liOrgs && (
                    <label className="mt-2 grid gap-1 text-xs text-foreground-muted">
                      <span>{g.linkedinPage}</span>
                      <select value={c.meta.liOrg ?? ""} disabled={busy || !manage} onChange={(e) => selectOrg(e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-xs" dir="auto">
                        {!c.meta.liOrg && <option value="" disabled>—</option>}
                        {(JSON.parse(c.meta.liOrgs) as { urn: string; name: string }[]).map((o) => <option key={o.urn} value={o.urn}>{o.name}</option>)}
                      </select>
                    </label>
                  )}
                  {c.provider === "linkedin" && c.meta?.via === "composio" && c.meta?.liOrg && (
                    <label className="mt-2 grid gap-1 text-xs text-foreground-muted">
                      <span>{g.postAs}</span>
                      <select value={c.meta.liPostAs === "org" ? "org" : "me"} disabled={busy || !manage} onChange={(e) => postAs(e.target.value === "org" ? "org" : "me")} className="rounded border border-border bg-surface px-2 py-1 text-xs" dir="auto">
                        <option value="me">{g.postAsMe}</option>
                        <option value="org">{(c.meta.liOrgs ? (JSON.parse(c.meta.liOrgs) as { urn: string; name: string }[]).find((o) => o.urn === c.meta?.liOrg)?.name : undefined) ?? c.meta.liOrg}</option>
                      </select>
                    </label>
                  )}
                  {c.provider === "meta" && c.meta?.pageId && !c.meta.igId && c.meta.via !== "composio" && <p className="mt-1 text-xs text-foreground-muted">{g.metaNoIg}</p>}
                  {READS_ADS.includes(c.provider) && c.meta?.adAccounts && (
                    <label className="mt-2 grid gap-1 text-xs text-foreground-muted">
                      <span>{g.adAccount}</span>
                      <select value={c.meta.adAccount} disabled={busy || !manage} onChange={(e) => selectAdAccount(c.provider, e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-xs" dir="auto">
                        {(JSON.parse(c.meta.adAccounts) as { id: string; name: string }[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                {manage && <div className="flex shrink-0 flex-col gap-1.5">
                  {c.needsReconnect && providerById.get(c.provider)?.kind === "oauth" && ((providerById.get(c.provider)!.toolkits?.length ?? 0) > 1 ? providerById.get(c.provider)!.toolkits! : [undefined]).map((tk) => (
                    <Button key={tk ?? "all"} size="sm" onClick={() => startOAuth(providerById.get(c.provider)!, tk)}>{g.reconnectBtn}{tk ? ` · ${partLabel[tk] ?? tk}` : ""}</Button>
                  ))}
                  {IMPORTS_PRODUCTS.includes(c.provider) && <Button variant="secondary" size="sm" disabled={busy} onClick={() => importProducts(c.provider)}>{g.importProducts}</Button>}
                  <Button variant="danger" size="sm" disabled={busy} aria-haspopup="dialog" onClick={() => disconnect(c.provider)}>{g.disconnect}</Button>
                </div>}
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
              // Working: publishes or imports. Reading ad results counts too (READS_ADS), and so do the reference files (READS_REFERENCES) and the cloud drives (DRIVES).
              const p = found && (isWorking(found.id) || READS_ADS.includes(found.id) || READS_REFERENCES.includes(found.id) || DRIVES.includes(found.id)) ? found : undefined;
              const part = p?.toolkits && p.toolkits.length > 1 && p.toolkits.includes(i.id) ? i.id : undefined;
              const isConnected = p ? (part ? !!conns.find((c) => c.provider === p.id)?.meta?.[PART_MARK[part]] : connectedIds.has(p.id)) : false;
              const ready = !!p?.available && !isConnected;
              // A lower role sees "ready to connect" with no button: asking for something that already exists would be noise.
              const canConnect = manage && ready;
              const status = isConnected ? "live" : p?.available ? "ready" : i.status;
              return (
                <div key={i.id} className="flex items-start justify-between gap-3 card card-sm">
                  <div>
                    <p className="font-display font-medium">{i.name}</p>
                    {i.note && <p className="mt-1 text-xs text-foreground-muted">{i.note}</p>}
                    <Badge tone={tone(status === "ready" ? "soon" : status)} className="mt-2">{status === "ready" ? g.ready : status === "live" ? g.connected : status === "soon" && p?.kind === "oauth" ? g.waiting : g.status[i.status]}</Badge>
                  </div>
                  {canConnect ? (
                    <Button size="sm" className="shrink-0" onClick={() => (p!.kind === "key" ? setKeyFor(p!) : startOAuth(p!, part))}>{g.connect}</Button>
                  ) : !isConnected && !ready ? (
                    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => req(i.id, i.name)} disabled={!!done[i.id]}>{done[i.id] ? `${g.requested} · ${done[i.id]}` : g.request}</Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <form onSubmit={(e) => { e.preventDefault(); if (other.trim()) { void req("other:" + other.trim().toLowerCase(), other.trim()); setOther(""); } }} className="mt-8 flex max-w-md items-end gap-2">
        <Field label={g.other} className="min-w-0 flex-1"><Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={80} /></Field>
        <Button type="submit">{g.send}</Button>
      </form>

      {/* Key and shop dialogs (rule 1089): a labelled native modal, Escape and the close button wait while it verifies. */}
      {keyFor && (
        <FormDialog lang={lang} title={keyFor.name} description={g.keyTitle} submitLabel={g.connect} busyLabel={g.verifying} cancelLabel={cancelWord} onSubmit={submitKey} onClose={() => setKeyFor(null)}>
          {keyFor.docs && <Callout tone="info" role="note"><span>{g.keyHelp}</span> <bdi dir="ltr" className="break-all">{keyFor.docs}</bdi></Callout>}
          {keyFor.keyFields?.map((f) => (
            <Field key={f.name} label={lang === "ar" ? f.labelAr : f.label} required>
              <Input name={f.name} type={f.type === "password" ? "password" : "text"} dir="ltr" placeholder={f.placeholder} autoComplete="off" spellCheck={false} />
            </Field>
          ))}
        </FormDialog>
      )}
      {shopFor && (
        <FormDialog lang={lang} title={shopFor.name} submitLabel={g.connect} cancelLabel={cancelWord} onClose={() => setShopFor(null)} onSubmit={async (data) => {
          const shop = String(data.get("shop") ?? "").trim();
          // Same hand-off as startOAuth: the route redirects off-origin to the provider.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- leaves the origin via a 302
          window.location.href = apiHref(`/api/connect/${shopFor.id}/start?lang=${lang}&shop=${encodeURIComponent(shop)}`);
        }}>
          <Field label={g.shopPrompt} required><Input name="shop" dir="ltr" autoComplete="off" spellCheck={false} /></Field>
        </FormDialog>
      )}
    </div>
  );
}
