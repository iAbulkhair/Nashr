"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { AgentId } from "@/lib/agents";
import { Icon } from "./Icons";

/**
 * The teammate card (Thakeen v2 phase 3, C4 + C12, rules 4739-4741). `ask` puts "@Name " in the message box, so the
 * person writes and sends the request themselves; `owner` sends PUT /api/conversations, the only way a thread's owner
 * moves. Nothing happens until the person presses it, and a login without the conversations role sees no button.
 */
export function TeamCard({
  card,
  conv,
  names,
  t,
  canAct,
  onAsk,
}: {
  card: { agent: AgentId; kind: "ask" | "owner" };
  conv: string;
  names: Record<AgentId, string>;
  t: AppDict;
  canAct: boolean;
  onAsk: (mention: string) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const name = names[card.agent];
  if (!canAct || (card.kind === "owner" && conv === "default")) return null;
  const own = () => {
    setState("busy");
    void fetch("/api/conversations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conv, owner: card.agent }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean }) => {
        setState(j.ok ? "done" : "fail");
      })
      .catch(() => setState("fail"));
  };
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" data-team-card={card.kind}>
      {card.kind === "ask" ? (
        <button type="button" onClick={() => onAsk(`@${name} `)} className="btn btn-secondary btn-xs">
          <Icon name="spark" className="h-3.5 w-3.5" />
          {t.chat.teamAsk.replace("{name}", name)}
        </button>
      ) : state === "done" ? (
        <p className="text-foreground-muted">{t.chat.teamOwnerDone.replace("{name}", name)}</p>
      ) : (
        <button type="button" onClick={own} disabled={state === "busy"} className="btn btn-secondary btn-xs">
          <Icon name="spark" className="h-3.5 w-3.5" />
          {t.chat.teamOwner.replace("{name}", name)}
        </button>
      )}
      {state === "fail" && <p className="text-danger">{t.chat.teamFail}</p>}
    </div>
  );
}
