import type { Task } from "../brand";
import { hasArtwork } from "../media-catalog";

/**
 * Where an inbox item can be published, from the stored connections alone. Its only runtime import is ../media-catalog,
 * which imports nothing, so the inbox (a client component) and the server routes use the same rule: the publish route
 * refuses any provider this does not list.
 *
 * One Meta connection gives two targets: "facebook" when a Page was chosen, and "instagram" when that Page has an
 * Instagram professional account linked. Both publish through the "meta" connection (CONNECTION_OF).
 */
export type ConnLite = { provider: string; meta?: Record<string, string> };

export const CONNECTION_OF: Record<string, string> = { facebook: "meta", instagram: "meta" };

/** Providers that publish only through Composio (via-composio.ts): a direct record of them is not a target. */
const VIA_ONLY = ["linkedin", "tiktok"];

/** The stored provider ids, plus the publish targets a Meta connection provides. */
export function connectedTargets(conns: ConnLite[]): string[] {
  const out = conns.filter((c) => !VIA_ONLY.includes(c.provider) || c.meta?.via === "composio").map((c) => c.provider);
  const meta = conns.find((c) => c.provider === "meta");
  if (meta?.meta?.pageId) out.push("facebook");
  // Through Composio, Instagram is its own connection and needs no Facebook Page.
  if (meta?.meta?.igId && (meta.meta.pageId || meta.meta.via === "composio")) out.push("instagram");
  return out;
}

/** Which providers can take which task. */
export function targetsFor(task: Task, connected: string[]): string[] {
  const out: string[] = [];
  const social = task.type === "social" || task.type === "cart_recovery";
  if (task.type === "article") for (const p of ["wordpress", "shopify"]) if (connected.includes(p)) out.push(p);
  if (task.type === "social" && task.channel === "x" && connected.includes("x")) out.push("x");
  if (task.type === "social" && task.channel === "linkedin" && connected.includes("linkedin")) out.push("linkedin");
  // TikTok takes a photo post as a draft in the owner's TikTok inbox, so it needs a generated image too.
  if (social && task.channel === "tiktok" && connected.includes("tiktok") && hasArtwork(task)) out.push("tiktok");
  // Instagram takes only a post with a generated image, from any provider: it has no text-only posts, and a placeholder
  // card is not artwork. A clip is never a target in this round, so a post with only a video does not qualify.
  if (social && task.channel === "instagram" && connected.includes("instagram") && hasArtwork(task)) out.push("instagram");
  if (social && (task.channel === "instagram" || task.channel === "facebook") && connected.includes("facebook")) out.push("facebook");
  if ((task.type === "social" || task.type === "gbp" || task.type === "whatsapp") && connected.includes("telegram")) out.push("telegram");
  return out;
}

/**
 * An article for a Salla store has no publish target: Salla's Merchant API has no endpoint to create a blog article or
 * a draft, so the inbox shows a copy-ready note instead of a button (docs/superpowers/specs/2026-10-05-store-connectors-design.md, section 6).
 */
export const copyOnlyNote = (task: Task, connected: string[]) => task.type === "article" && connected.includes("salla");
