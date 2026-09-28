import type { Task } from "../brand";

/**
 * Where an inbox item can be published, from the stored connections alone. No runtime imports, so the inbox (a client
 * component) and the server routes use the same rule: the publish route refuses any provider this does not list.
 *
 * One Meta connection gives two targets: "facebook" when a Page was chosen, and "instagram" when that Page has an
 * Instagram professional account linked. Both publish through the "meta" connection (CONNECTION_OF).
 */
export type ConnLite = { provider: string; meta?: Record<string, string> };

export const CONNECTION_OF: Record<string, string> = { facebook: "meta", instagram: "meta" };

/** The stored provider ids, plus the publish targets a Meta connection provides. */
export function connectedTargets(conns: ConnLite[]): string[] {
  const out = conns.map((c) => c.provider);
  const meta = conns.find((c) => c.provider === "meta");
  if (meta?.meta?.pageId) out.push("facebook");
  if (meta?.meta?.pageId && meta.meta.igId) out.push("instagram");
  return out;
}

/** Which providers can take which task. */
export function targetsFor(task: Task, connected: string[]): string[] {
  const out: string[] = [];
  const social = task.type === "social" || task.type === "cart_recovery";
  if (task.type === "article") for (const p of ["wordpress", "shopify"]) if (connected.includes(p)) out.push(p);
  if (task.type === "social" && task.channel === "x" && connected.includes("x")) out.push("x");
  // Instagram takes only a post with a generated image: it has no text-only posts.
  if (social && task.channel === "instagram" && connected.includes("instagram") && task.imageUrl && task.imageProvider === "fal") out.push("instagram");
  if (social && (task.channel === "instagram" || task.channel === "facebook") && connected.includes("facebook")) out.push("facebook");
  if ((task.type === "social" || task.type === "gbp" || task.type === "whatsapp") && connected.includes("telegram")) out.push("telegram");
  return out;
}
