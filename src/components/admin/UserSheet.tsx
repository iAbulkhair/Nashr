"use client";
import { useState } from "react";
import Sheet from "@/components/ui/Sheet";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import Badge from "@/components/ui/Badge";
import PaymentsPanel from "./PaymentsPanel";
import EntitlementsTable from "./EntitlementsTable";
import { sarText } from "@/lib/partner-rules";
import { formatCount, topupsSold, type AgencyDeal, type Plan } from "@/lib/pricing";
import type { TopupLot } from "@/lib/topups";
import { CHAT_LOW_SHARE, STR, type Detail, type Lang, type U } from "./shared";
import { USERS_COPY } from "./users-copy";
import { formatSuspensionEnd } from "@/lib/suspension";
import WorkspacePanel from "./WorkspacePanel";

/**
 * Red once the raw count reached the allowance (it can pass one lowered mid-period; an allowance of 0, chat stopped,
 * counts too) or CHAT_LOW_SHARE of it or less is left.
 */
export const chatLow = (counted: number, allowance: number | undefined, left: number | undefined) =>
  allowance != null && (counted >= allowance || (left ?? Math.max(0, allowance - counted)) <= allowance * CHAT_LOW_SHARE);

const TAB_IDS = ["overview", "billing", "usage", "activity", "brand", "workspace"] as const;
type Tab = (typeof TAB_IDS)[number];

/** A brand file value as one line of text: text as it is, a list joined, anything else as JSON. Text only, never HTML. */
const brandValue = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("، ") : JSON.stringify(v));

/**
 * One account in the founder console (rule 1180): a `Sheet` from the inline end, up to 48rem wide, with six tabs.
 * Overview holds the facts and every action (each asks its form first, rule 1176); Billing the payments and top-up
 * packs; Usage this month's model use, chat and entitlements; Activity the tasks and the brand activity log; Brand the
 * brand file as fields; Workspace the read-only team view (members, invites, brands, plan, rule 2083), loaded and audited
 * only when that tab opens. Closing it gives focus back to the account's button in the table.
 */
export default function UserSheet({
  lang, sel, busy, msg, payTick, onClose, dealText,
  act, extendTrial, setVideoGrant, setPlan, setSeats, setChat, setDeal, addCredits, addTopup, voidTopup, refundTopup, finishRefund,
}: {
  lang: Lang;
  sel: Detail;
  busy: boolean;
  msg: string;
  payTick: number;
  onClose: () => void;
  dealText: (d?: AgencyDeal | null) => string;
  act: (email: string, action: string, extra?: Record<string, unknown>) => Promise<unknown>;
  extendTrial: (email: string) => Promise<void>;
  setVideoGrant: (u: U) => Promise<void>;
  setPlan: (u: U) => Promise<void>;
  setSeats: (u: U) => Promise<void>;
  setChat: (u: U) => Promise<void>;
  setDeal: (u: U) => Promise<void>;
  addCredits: (email: string) => Promise<void>;
  addTopup: (u: U) => Promise<void>;
  voidTopup: (u: U, l: TopupLot) => Promise<void>;
  refundTopup: (u: U, l: TopupLot) => Promise<void>;
  finishRefund: (u: U, l: TopupLot) => Promise<void>;
}) {
  const S = STR[lang];
  const UC = USERS_COPY[lang];
  const [tab, setTab] = useState<Tab>("overview");
  const idBase = `account-${sel.user.email.replace(/[^a-z0-9]/gi, "-")}`;
  const brandEntries = sel.brand ? Object.entries(sel.brand).filter(([, v]) => v !== null && v !== undefined && v !== "") : [];
  return (
    <Sheet lang={lang} label={`${UC.sheetLabel} ${sel.user.email}`} onClose={onClose} side="end" size="lg">
      <div className="grid gap-4 p-5 pe-14">
        <header className="grid gap-1">
          <h2 className="font-display text-lg font-bold text-foreground"><bdi dir="ltr">{sel.user.email}</bdi></h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
            <span dir="auto">{sel.user.name}</span>
            <span aria-hidden>·</span>
            <bdi dir="ltr">{sel.user.phone}</bdi>
            <span aria-hidden>·</span>
            <span>{sel.user.plan}{sel.user.plan === "agency" ? ` (${dealText(sel.user.deal)})` : ""}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatCount(sel.user.credits)} {UC.creditsWord}</span>
            {sel.user.suspended && <Badge tone="danger"><span suppressHydrationWarning>{UC.suspendedBadge}{sel.user.suspendedUntil ? ` · ${UC.suspendedUntil(formatSuspensionEnd(sel.user.suspendedUntil, lang))}` : ""}</span></Badge>}
            {sel.user.emailVerifiedAt ? <span>{S.verifiedOn} <bdi dir="ltr">{sel.user.emailVerifiedAt.slice(0, 10)}</bdi></span> : <Badge tone="warning">{S.unverified}</Badge>}
          </p>
        </header>
        {msg && <p role="status" className="text-sm text-foreground" dir="auto">{msg}</p>}
        <Tabs idBase={idBase} label={UC.sheetLabel} value={tab} onChange={setTab} items={TAB_IDS.map((id) => ({ id, label: UC.tabs[id] }))} />

        <TabPanel idBase={idBase} id="overview" value={tab} className="grid gap-4">
          <section aria-label={UC.actions} className="flex flex-wrap gap-2 text-xs">
            <button disabled={busy} onClick={() => act(sel.user.email, "impersonate")} className="btn btn-primary btn-xs min-h-[var(--hit-min)]">{S.impersonate}</button>
            <button disabled={busy} onClick={() => setPlan(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{UC.planTitle}</button>
            {sel.user.plan === "agency" && <button disabled={busy} onClick={() => setDeal(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.setDeal}</button>}
            <button disabled={busy} onClick={() => setSeats(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.setSeats}</button>
            <button disabled={busy} onClick={() => setChat(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.setChat}</button>
            <button disabled={busy} onClick={() => addCredits(sel.user.email)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.addCredits}</button>
            <button disabled={busy} onClick={() => extendTrial(sel.user.email)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.extend}</button>
            <button disabled={busy} onClick={() => setVideoGrant(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]" data-testid="video-grant-button">{S.grantVideo}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "resetPassword")} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.reset}</button>
            {/* Rule 777: only while the address is unproved; the route refuses a verified owner and rate-limits per address. */}
            {!sel.user.emailVerifiedAt && <button disabled={busy} onClick={() => act(sel.user.email, "resendVerification")} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.resendCode}</button>}
            <button disabled={busy} onClick={() => act(sel.user.email, "setLang", { lang: sel.user.lang === "ar" ? "en" : "ar" })} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.emailsIn} {sel.user.lang === "ar" ? S.english : S.arabic}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, sel.user.suspended ? "unsuspend" : "suspend")} className={`btn btn-xs min-h-[var(--hit-min)] ${sel.user.suspended ? "btn-primary" : "btn-danger"}`}>{sel.user.suspended ? S.unsuspend : S.suspend}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "delete")} className="btn btn-danger-solid btn-xs min-h-[var(--hit-min)]">{S.del}</button>
          </section>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded border border-border p-2"><p className="text-foreground-muted">{S.trialRenewed}</p><p className="font-mono" dir="ltr">{sel.user.trialEnds.slice(0, 10)} · {sel.user.renewedAt ?? "—"}</p>{/* The detail answer carries the record (`handPlan`), the list row its day (`paidThrough`), rule 1302. */}{(sel.user.handPlan?.paidThrough ?? sel.user.paidThrough) && <p className="text-xs text-foreground-muted" data-paid-through>{UC.paidThrough} <bdi className="font-mono" dir="ltr">{sel.user.handPlan?.paidThrough ?? sel.user.paidThrough}</bdi></p>}<p className="text-xs text-foreground-muted">{UC.joinedOn} <bdi className="font-mono" dir="ltr">{sel.user.createdAt.slice(0, 10)}</bdi></p></div>
            <div className="rounded border border-border p-2"><p className="text-foreground-muted">{S.integrations}</p><p className="font-mono">{sel.connections.length ? sel.connections.map((c) => c.provider).join(", ") : UC.none}</p></div>
            <div className="rounded border border-border p-2"><p className="text-foreground-muted">{S.brandsEtc}</p><p className="font-mono">{sel.brands.length} · {sel.conversations} · {sel.referrals} · {sel.avgScore ?? "—"}</p></div>
          </div>
        </TabPanel>

        <TabPanel idBase={idBase} id="billing" value={tab} className="grid gap-4">
          {/* Partner programme: record payments (the source of truth for commissions) and void them (src/lib/partners.ts). */}
          <PaymentsPanel key={`${sel.user.email}:${payTick}`} email={sel.user.email} lang={lang} />
          {/* Top-up packs (rules 446-447): what is left of each, when it expires, what was paid and when, the reference and who
              activated it. Text only: the reference is what the founder typed. */}
          <div className="rounded border border-border p-3 text-xs" data-testid="topups-detail">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-foreground-muted">{S.topups}{sel.user.topups?.length ? ` · ${formatCount(sel.user.topups.reduce((n, l) => n + l.left, 0))}` : ""}</p>
              <button disabled={busy || !topupsSold(sel.user.plan as Plan)} title={topupsSold(sel.user.plan as Plan) ? S.addTopup : S.topupTrial} onClick={() => addTopup(sel.user)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.addTopup}</button>
            </div>
            {!topupsSold(sel.user.plan as Plan) && <p className="mt-1 text-foreground-muted">{S.topupTrial}</p>}
            {/* One entry point for a top-up's payment (rule 454): this block records it, the Payments panel never does. */}
            <p className="mt-1 text-foreground-muted" data-topup-pay-note>{S.topupPayNote}</p>
            <p className="mt-1 text-foreground-muted" data-topup-refund-note>{S.topupRefundNote}</p>
            {!sel.user.topups?.length ? <p className="mt-1 text-foreground-muted">{S.noTopups}</p> : (
              <div className="overflow-x-auto">
                <table className="mt-1 w-full font-mono">
                  <tbody>
                    {sel.user.topups.map((l) => (
                      <tr key={l.id} className="border-t border-border" data-lot={l.id}>
                        <td className="py-0.5 pe-2" dir="ltr">{formatCount(l.left)} / {formatCount(l.credits)} {S.topupLeft}</td>
                        <td className="pe-2">{S.topupExpires} <span dir="ltr">{l.expiresAt.slice(0, 10)}</span></td>
                        <td className="pe-2">{S.topupPaid} <span dir="ltr">{l.paidSar} SAR</span> {S.topupOn} <span dir="ltr">{l.paidOn}</span></td>
                        <td className="pe-2" dir="auto">{l.ref ? `${S.topupRef} ${l.ref}` : ""}</td>
                        <td className="pe-2" dir="ltr">{S.topupBy} {l.by}</td>
                        {/* Rule 460: a refunded pack shows its refund (the transfer's reference is the founder's own text);
                            a paid pack with credits left can be refunded once. */}
                        <td className="pe-2" dir="auto" data-refund={l.refund ? "done" : undefined}>{l.refund
                          ? <>{S.topupRefunded(l.refund.credits, sarText(l.refund.sar), l.refund.on)}{l.refund.ref ? ` · ${S.topupRef} ${l.refund.ref}` : ""}
                            {/* Rule 465: the refund is on the pack but not on its payment yet (a request that stopped). */}
                            {sel.unfinishedRefunds?.includes(l.id) && <> · <button type="button" disabled={busy} title={S.finishRefundTitle} onClick={() => finishRefund(sel.user, l)} className="min-h-[var(--hit-min)] text-danger underline" data-finish-refund>{S.finishRefund}</button></>}</>
                          : l.paidSar > 0 && l.left > 0 && <button type="button" disabled={busy} onClick={() => refundTopup(sel.user, l)} className="min-h-[var(--hit-min)] text-foreground underline">{S.refundTopup}</button>}</td>
                        <td className="text-end"><button type="button" disabled={busy} onClick={() => voidTopup(sel.user, l)} className="min-h-[var(--hit-min)] text-danger underline">{S.voidTopup}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabPanel>

        <TabPanel idBase={idBase} id="usage" value={tab} className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded border border-border p-2"><p className="text-foreground-muted">{S.usage}</p><p className="font-mono" dir="ltr">{Math.round((sel.usage.in + sel.usage.out) / 1000)}k {UC.tokensWord} · ${sel.usage.usd.toFixed(2)} · {sel.usage.calls} {UC.callsWord}</p><p className="font-mono text-xs text-foreground-muted" dir="ltr">{Object.entries(sel.usage.kinds).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</p></div>
          {sel.chat && (
            <div className="rounded border border-border p-2" data-testid="chat-detail">
              <p className="text-foreground-muted">{S.chatMessages} ({sel.chat.period === "trial" ? S.chatTrial : S.chatMonth})</p>
              {/* The raw count, as the list shows it, and this month's messages on credits with what they were billed. */}
              <p className={`font-mono ${chatLow(sel.chat.counted, sel.chat.allowance, sel.chat.left) ? "font-semibold text-danger" : ""}`}>{sel.chat.counted} / {sel.chat.allowance}{sel.chat.overflow.used > 0 || sel.chat.overflow.credits > 0 ? ` · ${S.onCredits(sel.chat.overflow.used, sel.chat.overflow.credits)}` : ""}</p>
              <p className="font-mono text-xs text-foreground-muted">{S.overflow}: {!sel.chat.overflow.available ? S.overflowTrial : sel.chat.overflow.on ? S.overflowOn : S.overflowOff}{sel.usage.byKind?.chat ? ` · ${S.chatCost} ${sel.usage.byKind.chat.usd.toFixed(2)}` : ""}{sel.chatUsdPerMsg != null ? ` · ${S.perMsg} ${sel.chatUsdPerMsg.toFixed(4)}` : ""}</p>
            </div>
          )}
          {sel.entitlements && <div className="col-span-full min-w-0"><EntitlementsTable view={sel.entitlements} lang={lang} deal={sel.user.deal} /></div>}
          {sel.usage.byKind && Object.keys(sel.usage.byKind).length > 0 && (
            <div className="col-span-full overflow-x-auto rounded border border-border p-2">
              <p className="text-foreground-muted">{S.perKind}</p>
              <table className="mt-1 w-full font-mono text-xs" dir="ltr">
                <tbody>
                  {Object.entries(sel.usage.byKind).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => (
                    <tr key={k} className="border-t border-border">
                      <td className="py-0.5">{k}</td>
                      <td className="text-end">{v.calls}×</td>
                      <td className="text-end">${(v.usd / Math.max(1, v.calls)).toFixed(4)}</td>
                      <td className="text-end">${v.usd.toFixed(2)}</td>
                      <td className="text-end text-foreground-muted">{Math.round((v.in + v.out) / 1000)}k</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sel.usage.byAgent && Object.keys(sel.usage.byAgent).length > 0 && (
            <div className="col-span-full overflow-x-auto rounded border border-border p-2">
              <p className="text-foreground-muted">{S.perAgent}</p>
              <table className="mt-1 w-full font-mono text-xs" dir="ltr">
                <tbody>
                  {Object.entries(sel.usage.byAgent).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => (
                    <tr key={k} className="border-t border-border">
                      <td className="py-0.5">{k}</td>
                      <td className="text-end">{v.calls}×</td>
                      <td className="text-end">${(v.usd / Math.max(1, v.calls)).toFixed(4)}</td>
                      <td className="text-end">${v.usd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>

        <TabPanel idBase={idBase} id="activity" value={tab} className="grid gap-3">
          <h3 className="text-xs font-semibold text-foreground-muted">{UC.tasks} ({sel.tasks.length}) · {S.approved} {sel.tasks.filter((t) => t.status === "approved").length} · {S.rejected} {sel.tasks.filter((t) => t.status === "rejected").length}</h3>
          <ul className="grid max-h-96 gap-2 overflow-auto">
            {sel.tasks.map((t) => (
              <li key={t.id} className="rounded border border-border p-3 text-xs">
                <div className="flex justify-between gap-2 text-foreground-muted"><span>{t.type} · {t.channel} · {t.status}{t.quality ? ` · ${S.judge} ${t.quality.score}` : ""}</span><bdi className="font-mono" dir="ltr">{t.createdAt.slice(0, 16).replace("T", " ")}</bdi></div>
                <p className="mt-1 whitespace-pre-wrap" dir="auto">{(t.editedBody ?? t.body).slice(0, 600)}</p>
              </li>
            ))}
          </ul>
          <h3 className="text-xs font-semibold text-foreground-muted">{S.activity}</h3>
          {(sel.activity ?? []).map((b) => (
            <div key={b.brand} className="max-h-72 overflow-auto rounded border border-border p-2">
              <p className="text-xs text-foreground-muted" dir="auto">{b.name} · {b.rows.length}</p>
              {b.rows.length === 0 ? <p className="text-xs text-foreground-muted">{S.activityNone}</p> : (
                <table className="mt-1 w-full font-mono text-xs">
                  <tbody>
                    {/* Text only: the note is a title or file name a model or an outside app wrote. */}
                    {b.rows.map((a, i) => (
                      <tr key={`${a.at}-${i}`} className="border-t border-border align-top">
                        <td className="whitespace-nowrap py-0.5 pe-2" dir="ltr">{a.at.slice(0, 16).replace("T", " ")}</td>
                        <td className="pe-2">{a.agent ?? "—"}</td>
                        <td className="pe-2">{a.kind}{a.outcome ? ` · ${a.outcome}` : ""}{a.score !== undefined ? ` · ${a.score}` : ""}</td>
                        <td className="pe-2">{a.via}</td>
                        <td className="pe-2" dir="ltr">{a.by.kind}{a.by.email && a.by.kind === "member" ? ` · ${a.by.email}` : ""}</td>
                        <td className="pe-2 text-end">{a.credits ?? ""}</td>
                        <td dir="auto">{a.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </TabPanel>

        <TabPanel idBase={idBase} id="brand" value={tab}>
          {/* The brand file as fields, text only: every value is the customer's or a crawled page's text (untrusted). */}
          {brandEntries.length === 0 ? <p className="text-sm text-foreground-muted">{UC.noBrand}</p> : (
            <dl className="grid gap-2 text-sm" aria-label={UC.brandFields}>
              {brandEntries.map(([k, v]) => (
                <div key={k} className="grid gap-0.5 rounded border border-border p-2 sm:grid-cols-[10rem_1fr] sm:gap-3">
                  <dt className="font-mono text-xs text-foreground-muted" dir="ltr">{k}</dt>
                  <dd className="whitespace-pre-wrap break-words" dir="auto">{brandValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </TabPanel>

        <TabPanel idBase={idBase} id="workspace" value={tab}>
          <WorkspacePanel lang={lang} email={sel.user.email} />
        </TabPanel>
      </div>
    </Sheet>
  );
}
