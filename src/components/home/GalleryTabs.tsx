"use client";
import { useState } from "react";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import Badge from "@/components/ui/Badge";
import ApprovalCard from "@/components/app/ApprovalCard";
import ChatBubble from "@/components/app/ChatBubble";
import { PlanCard } from "@/components/app/OnboardCards";
import type { ApprovalDict } from "@/lib/approval-dict";
import { GALLERY_TABS, type GalleryTab, type GallerySamples } from "@/lib/home-gallery";
import { render } from "@/lib/md";

/** One language's gallery copy, as plain strings. */
export type GalleryText = { label: string; note: string; tabsLabel: string; tabs: Record<GalleryTab, { label: string; cap: string }> };

/**
 * The gallery's screens (rule 1222): the `Tabs` primitive over three panels, each a frame labelled as an illustrative
 * example (rule 1221) holding the app's own components with sample data. Every component runs in `demo`: Approve, Undo
 * and Add change only the card on screen and send nothing. Copy works, on the sample text. Nothing moves by itself.
 */
export default function GalleryTabs({ lang, t, samples, text }: { lang: "ar" | "en"; t: ApprovalDict; samples: GallerySamples; text: GalleryText }) {
  const [tab, setTab] = useState<GalleryTab>("chat");
  const idBase = "home-gallery";
  return (
    <div className="grid gap-4">
      <Tabs idBase={idBase} label={text.tabsLabel} value={tab} onChange={setTab} items={GALLERY_TABS.map((id) => ({ id, label: text.tabs[id].label }))} className="max-w-full flex-wrap justify-self-start bg-surface" />
      {GALLERY_TABS.map((id) => (
        <TabPanel key={id} idBase={idBase} id={id} value={tab} className="grid gap-3 rounded-2xl border border-border bg-background p-3 text-foreground sm:p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone="info">{text.label}</Badge>
            <p className="text-sm text-foreground-muted">{text.tabs[id].cap}</p>
          </div>
          {id === "chat" && (
            <div className="grid gap-3">
              <ChatBubble role="user"><p className="whitespace-pre-wrap">{samples.chat.ask}</p></ChatBubble>
              <ChatBubble role="assistant" name={t.agents.noor.name} wide>
                {/* Fixed sample text, still through render() like every answer. */}
                <div className="prose-nashr prose-compact" dangerouslySetInnerHTML={{ __html: render(samples.chat.reply) }} />
                <div className="mt-1"><ApprovalCard item={samples.chat.item} t={t} lang={lang} demo /></div>
              </ChatBubble>
            </div>
          )}
          {id === "plan" && <PlanCard plan={samples.plan} lang={lang} demo onStart={() => setTab("chat")} />}
          {id === "inbox" && (
            <ul className="grid gap-1" role="list">
              {samples.inbox.map((it) => <li key={it.id}><ApprovalCard item={it} t={t} lang={lang} demo /></li>)}
            </ul>
          )}
          <p className="text-xs text-foreground-muted">{text.note}</p>
        </TabPanel>
      ))}
    </div>
  );
}
