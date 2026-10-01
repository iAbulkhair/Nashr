"use client";
import { useState } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import type { partnerDashboard } from "@/lib/partners";
import { PARTNER_COPY } from "@/lib/partner-copy";
import { sarText } from "@/lib/partner-rules";

type Data = NonNullable<Awaited<ReturnType<typeof partnerDashboard>>>;

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-secondary btn-sm">
      {copied ? done : label}
    </button>
  );
}

/**
 * The partner page body (rules 399, 411-413). Everything shown comes from `partnerDashboard`: no customer name or email
 * (each referral is a stable label), the IBAN masked. The bank form posts to PUT /api/partner, owner only: any country's
 * IBAN, the country the partner lives in (the options come from the server, `countryOptions`), an optional VAT or tax
 * registration number and a separate "I am VAT-registered" box (a tax number alone flags nothing for the founder). The
 * page links the programme terms.
 */
export default function PartnerPanel({ lang, link, data, bankEditable, countries }: { lang: Lang; link: string; data: Data; bankEditable: boolean; countries: [string, string][] }) {
  const S = PARTNER_COPY[lang];
  const share = S.share(data.code, link);
  const [bank, setBank] = useState(data.bank);
  const [holder, setHolder] = useState(data.bank?.holder ?? "");
  const [iban, setIban] = useState("");
  const [country, setCountry] = useState(data.bank?.country ?? "SA");
  const [taxNumber, setTaxNumber] = useState(data.bank?.taxNumber ?? "");
  const [vatRegistered, setVatRegistered] = useState(data.bank?.vatRegistered ?? false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function saveBank(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch("/api/partner", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holder, iban, country, taxNumber, vatRegistered }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; bank?: { holder: string; iban: string; country: string; taxNumber: string | null; vatRegistered: boolean } };
      if (!j.ok || !j.bank) return setErr(S.errors[j.error ?? "server"] ?? S.errors.server);
      setBank({ ...j.bank, savedAt: new Date().toISOString(), confirmed: false });
      setIban("");
      setMsg(S.saved);
    } catch {
      setErr(S.errors.server);
    } finally {
      setBusy(false);
    }
  }
  const th = "p-2 text-start font-medium text-ink/60";
  const td = "p-2";
  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <div>
        <h1 className="page-title">{S.title}</h1>
        <p className="mt-2 text-ink/70">{S.sub}</p>
      </div>

      <div className="card grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs uppercase tracking-wide text-ink/50">{S.code}</p>
          <code data-partner-code className="rounded bg-salt-dim px-3 py-1 font-mono text-lg font-bold" dir="ltr">{data.code}</code>
          <CopyButton text={data.code} label={S.copy} done={S.copied} />
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/50">{S.link}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded bg-salt-dim px-3 py-2 text-sm" dir="ltr">{link}</code>
            <CopyButton text={link} label={S.copy} done={S.copied} />
          </div>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/50">{S.shareTitle}</p>
          <p className="mt-1 whitespace-pre-wrap rounded bg-salt-dim px-3 py-2 text-sm" dir="auto">{share}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton text={share} label={S.copy} done={S.copied} />
            <a href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">{S.shareWa}</a>
          </div>
        </div>
        <p className="text-xs text-ink/60">{S.rules} <Link href={`/${lang}/affiliates/terms`} data-terms-link className="text-oasis underline">{S.terms}</Link></p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([[S.stats.referrals, String(data.referrals.length)], [S.stats.pending, sarText(data.pending)], [S.stats.payable, sarText(data.payable)], [S.stats.paid, sarText(data.paid)]] as const).map(([l, v]) => (
          <div key={l} className="card card-sm"><p className="text-xs text-ink/60">{l}</p><p className="tnum font-display text-2xl font-bold text-oasis" dir="ltr">{v}</p></div>
        ))}
      </div>
      {data.pending > 0 && <p className="-mt-3 text-xs text-ink/60">{S.pendingNote}</p>}

      <section className="card">
        <h2 className="font-display text-lg font-bold">{S.referrals}</h2>
        {data.referrals.length === 0 ? <p className="mt-2 text-sm text-ink/60">{S.refsEmpty}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>{S.refCols.label}</th><th className={th}>{S.refCols.signedUp}</th><th className={th}>{S.refCols.status}</th><th className={th}>{S.refCols.months}</th></tr></thead>
              <tbody>{data.referrals.map((r) => (
                <tr key={r.label} className="border-t border-ink/5"><td className={`${td} font-mono`} dir="ltr">{r.label}</td><td className={`${td} tnum`} dir="ltr">{r.signedUpOn}</td><td className={td}>{S.status[r.status]}</td><td className={`${td} tnum`}>{r.months}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-display text-lg font-bold">{S.ledger}</h2>
        {data.commissions.length === 0 ? <p className="mt-2 text-sm text-ink/60">{S.ledgerEmpty}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>{S.ledgerCols.label}</th><th className={th}>{S.ledgerCols.date}</th><th className={th}>{S.ledgerCols.base}</th><th className={th}>{S.ledgerCols.sar}</th></tr></thead>
              <tbody>{data.commissions.map((c, i) => (
                <tr key={`${c.label}-${c.paymentDate}-${i}`} className={`border-t border-ink/5 ${c.voided ? "text-ink/40 line-through" : ""}`}><td className={`${td} font-mono`} dir="ltr">{c.label}</td><td className={`${td} tnum`} dir="ltr">{c.paymentDate}</td><td className={`${td} tnum`} dir="ltr">{sarText(c.baseSar)}</td><td className={`${td} tnum`} dir="ltr">{sarText(c.sar)}{c.voided ? ` (${S.voided})` : ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-display text-lg font-bold">{S.payouts}</h2>
        {data.payouts.length === 0 ? <p className="mt-2 text-sm text-ink/60">{S.payoutsEmpty}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>{S.payoutCols.date}</th><th className={th}>{S.payoutCols.sar}</th><th className={th}>{S.payoutCols.vat}</th><th className={th}>{S.payoutCols.reference}</th></tr></thead>
              <tbody>{data.payouts.map((p, i) => (
                <tr key={`${p.date}-${i}`} className={`border-t border-ink/5 ${p.voided ? "text-ink/40 line-through" : ""}`}><td className={`${td} tnum`} dir="ltr">{p.date}</td><td className={`${td} tnum`} dir="ltr">{sarText(p.sar)}</td><td className={`${td} tnum`} dir="ltr">{p.vatSar ? sarText(p.vatSar) : "—"}</td><td className={td} dir="auto">{p.reference || "—"}{p.voided ? ` (${S.voided})` : ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="font-display text-lg font-bold">{S.bank}</h2>
        <p className="mt-1 text-sm text-ink/60">{S.bankNote}</p>
        <p data-tax-note className="mt-1 text-sm text-ink/60">{S.taxNote}</p>
        {bank && <p data-bank-masked className="mt-2 text-sm"><span dir="auto">{bank.holder}</span> · <span className="font-mono" dir="ltr">{bank.iban}</span>{bank.country ? <> · <span>{countries.find(([c]) => c === bank.country)?.[1] ?? bank.country}</span></> : null}{bank.taxNumber ? <> · <span className="font-mono" dir="ltr">{bank.taxNumber}</span></> : null}</p>}
        {bank && !bank.confirmed && <p data-bank-pending className="mt-1 text-xs text-sadu">{S.bankPending}</p>}
        {bankEditable ? (
          <form onSubmit={saveBank} className="mt-3 grid gap-2 sm:max-w-md">
            <input value={holder} onChange={(e) => setHolder(e.target.value)} required maxLength={80} autoComplete="name" placeholder={S.holder} aria-label={S.holder} className="input" />
            <input value={iban} onChange={(e) => setIban(e.target.value)} required maxLength={42} autoComplete="off" dir="ltr" placeholder={S.iban} aria-label={S.iban} className="input font-mono" />
            <label className="grid gap-1 text-sm"><span className="text-ink/60">{S.country}</span>
              <select value={country} onChange={(e) => setCountry(e.target.value)} required aria-label={S.country} className="input">
                {countries.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
              </select>
            </label>
            <input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} maxLength={30} autoComplete="off" dir="ltr" placeholder={S.taxNumber} aria-label={S.taxNumber} className="input font-mono" />
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="vatRegistered" checked={vatRegistered} onChange={(e) => setVatRegistered(e.target.checked)} className="mt-1" /><span>{S.vatRegistered}</span></label>
            <button disabled={busy} className="btn btn-primary">{S.save}</button>
            {msg && <p className="text-sm text-oasis">{msg}</p>}
            {err && <p role="alert" className="text-sm text-sadu-deep">{err}</p>}
          </form>
        ) : <p className="mt-2 text-xs text-ink/60">{S.errors.forbidden}</p>}
      </section>
    </div>
  );
}
