"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { ChatStatus } from "@/lib/chat-allowance";
import { chatOverflowHold, formatCount } from "@/lib/pricing";

/**
 * `credits`: the balance (the month's plan credits and any top-up pack) does not cover the work; the way out is a top-up
 * pack or an upgrade on the Subscription page.
 * `agent_cap`: an agent reached the monthly credit cap the owner set in Governance; the way out is Governance, not billing
 * (a top-up does not lift a cap: the cap counts every credit the agent spends, wherever it came from).
 * `chat`: the account's chat messages are used up and chat is paused (POST /api/chat answered 402 `chat_allowance`);
 * `chat_credits`: "continue on credits" is on but the balance is below `overflow.hold`, the least a message on credits
 * needs (402 `chat_credits`). Nothing is taken before a message: after the reply it is billed what it actually cost.
 */
export type LimitKind = "credits" | "trial" | "agent_cap" | "chat" | "chat_credits";
/**
 * What the chat dialogs take from the server's ChatStatus: the trial's wording, the least balance a message on credits
 * needs (`overflow.hold`), and the allowance (0: the founder turned chat off for the account, so no renewal is promised).
 */
export type LimitDetail = { period?: ChatStatus["period"]; hold?: number; allowance?: number };
type Open = LimitDetail & { kind: LimitKind };
/** Raise the paywall from anywhere on the client. */
export function raiseLimit(kind: LimitKind, detail: LimitDetail = {}) {
  window.dispatchEvent(new CustomEvent("nashr:limit", { detail: { ...detail, kind } }));
}
/** Map an API error to a limit kind, raising the modal. Returns true when handled. */
export function limitFromError(error?: string): boolean {
  if (error === "no_credits") { raiseLimit("credits"); return true; }
  if (error === "trial_over") { raiseLimit("trial"); return true; }
  if (error === "agent_cap") { raiseLimit("agent_cap"); return true; }
  return false;
}

/**
 * The dialog's title and body for one kind and role: the owner is sent to the page that fixes it, anyone else to the
 * owner. `topups`: the account may buy top-up packs (a paid plan, `topupsSold`); out of credits, the owner is offered a
 * pack before an upgrade, and a trial is told packs come with a plan.
 */
export function limitText(L: AppDict["limit"], open: Open, may: boolean, topups = true): [string, string] {
  const hold = formatCount(open.hold ?? chatOverflowHold());
  switch (open.kind) {
    case "credits": return [L.creditsTitle, topups ? (may ? L.creditsBody : L.askOwner) : (may ? L.creditsTrialBody : L.askOwnerCreditsTrial)];
    case "trial": return [L.trialTitle, may ? L.trialBody : L.askOwnerTrial];
    case "agent_cap": return [L.agentCapTitle, may ? L.agentCapBody : L.askOwnerCap];
    case "chat":
      if (open.allowance === 0) return [L.chatOffTitle, may ? L.chatOffBody : L.askOwnerChatOff];
      return open.period === "trial" ? [L.chatTrialTitle, may ? L.chatTrialBody : L.askOwnerChatTrial] : [L.chatTitle, may ? L.chatBody : L.askOwnerChat];
    case "chat_credits": return [L.chatCreditsTitle, (may ? L.chatCreditsBody : L.askOwnerChatCredits).split("{hold}").join(hold)];
  }
}

/**
 * The one line the generate and reports panels show next to the dialog when a request is short of credits (rule 457):
 * the owner of a paid plan is offered a top-up pack or an upgrade, a trial's owner a plan (packs are sold to paid plans
 * only, `topupsSold`), and anyone else is told to ask the owner, with the same split.
 */
export function noCreditsText(g: AppDict["generate"], may: boolean, topups: boolean): string {
  if (may) return topups ? g.noCredits : g.noCreditsTrial;
  return topups ? g.noCreditsAsk : g.noCreditsAskTrial;
}

/**
 * `owner`: the acting person may subscribe (`can(u, "billing")`); `governs`: may raise agent caps
 * (`can(u, "governance.write")`); `topups`: the account's plan may buy top-up packs (`topupsSold`). Anyone else is told
 * to ask the account owner rather than sent to a page they cannot change.
 */
export default function LimitModal({ t, lang, owner = true, governs = true, topups = true }: { t: AppDict; lang: Lang; owner?: boolean; governs?: boolean; topups?: boolean }) {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<Open>).detail);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("nashr:limit", on);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("nashr:limit", on); window.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => { if (open) document.getElementById("limit-later")?.focus(); }, [open]);
  if (!open) return null;
  const L = t.limit;
  const kind = open.kind;
  const may = kind === "agent_cap" ? governs : owner;
  const [title, body] = limitText(L, open, may, topups);
  // Out of credits on a paid plan: straight to the top-up packs on the Subscription page (rule 450).
  const topup = kind === "credits" && topups;
  // The chat's month dialogs lead to the Subscription page, where the plan and "continue on credits" both live.
  const cta = topup ? L.topup : (kind === "chat" && open.period !== "trial") || kind === "chat_credits" ? L.billing : L.plans;
  // Chat turned off for the account (an allowance of 0): no page the owner can open fixes it, so only the OK button.
  const act = may && !(kind === "chat" && open.allowance === 0);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="limit-title" className="fixed inset-0 z-[60] grid place-items-center bg-overlay p-4" onClick={() => setOpen(null)}>
      <div className="card w-full max-w-md border-border-strong p-8 text-center" onClick={(e) => e.stopPropagation()}>
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-full border-[1.5px] border-border-strong bg-lemon font-display text-2xl font-bold text-accent-foreground" aria-hidden>ذ</span>
        <h2 id="limit-title" className="mt-5 font-display text-2xl font-bold">{title}</h2>
        <p className="page-sub">{body}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button id="limit-later" onClick={() => setOpen(null)} className={`btn ${act ? "btn-secondary" : "btn-primary"}`}>{act ? L.later : L.ok}</button>
          {!act ? null : kind === "agent_cap" ? <Link href={`/${lang}/app/settings/governance`} className="btn btn-primary">{L.governance}</Link> : <Link href={`/${lang}/app/settings/billing${topup ? "#topup" : ""}`} className="btn btn-primary">{cta}</Link>}
        </div>
      </div>
    </div>
  );
}
