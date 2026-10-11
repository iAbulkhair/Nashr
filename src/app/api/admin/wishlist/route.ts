import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { TITLE_MAX, isWishStatus, type WishArea } from "@/lib/changelog";
import { cleanText, existingId, listSuggestions, listWishes, promoteWish, removeSuggestion, removeWish, restoreWish, setWishStatus, wellFormedId } from "@/lib/wishlist";
import { adminAudit } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

const AREAS: readonly WishArea[] = ["agents", "onboarding", "content", "channels", "commerce", "ads", "reports", "team", "billing", "integrations", "app"];
const log = (what: string, after: unknown) => adminAudit({ actor: "founder", section: "wishlist", target: "wishlist", what, after });
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Founder console, Wishlist tab: the moderation queue and every item (hidden ones included) with its votes. */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [suggestions, items] = await Promise.all([listSuggestions(), listWishes(null, { includeHidden: true })]);
  return NextResponse.json({ ok: true, suggestions, items });
}

/**
 * POST {action, ...}
 *   promote  {title: {ar, en}, area?, suggestionId?}  publish a wish under a title the founder writes
 *   status   {id, status}                               planned | in_progress | shipped
 *   delete   {id}                                       hide a seeded item, delete a promoted one with its votes
 *   restore  {id}                                       show a hidden seeded item again
 *   dismiss  {suggestionId}                             drop a suggestion from the queue
 */
export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; id?: unknown; status?: unknown; title?: { ar?: unknown; en?: unknown }; area?: unknown; suggestionId?: unknown };
  const suggestionId = wellFormedId(b.suggestionId) ? b.suggestionId : undefined;
  switch (b.action) {
    case "promote": {
      const title = { ar: cleanText(b.title?.ar), en: cleanText(b.title?.en) };
      if (!title.ar || !title.en) return bad("title_required");
      if (title.ar.length > TITLE_MAX || title.en.length > TITLE_MAX) return bad("title_too_long");
      const area = AREAS.find((a) => a === b.area);
      const item = await promoteWish(title, area, suggestionId);
      await log("wish:promote", item);
      return NextResponse.json({ ok: true, item });
    }
    case "status": {
      const id = await existingId(b.id);
      if (!id) return bad("unknown_item");
      if (!isWishStatus(b.status)) return bad("bad_status");
      await setWishStatus(id, b.status);
      await log("wish:status", { id, status: b.status });
      return NextResponse.json({ ok: true });
    }
    case "delete":
    case "restore": {
      const id = await existingId(b.id);
      if (!id) return bad("unknown_item");
      await (b.action === "delete" ? removeWish(id) : restoreWish(id));
      await log(`wish:${b.action}`, { id });
      return NextResponse.json({ ok: true });
    }
    case "dismiss": {
      if (!suggestionId || !(await removeSuggestion(suggestionId))) return bad("unknown_suggestion");
      await log("wish:dismiss", { suggestionId });
      return NextResponse.json({ ok: true });
    }
    default:
      return bad("unknown_action");
  }
}
