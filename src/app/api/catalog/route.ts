import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { importCatalog } from "@/lib/catalog";
import { wsKey } from "@/lib/keys";
import { CATALOG_IMPORTS_PER_HOUR, WINDOW, allow, retryLater } from "@/lib/rate";
import { forbid } from "@/lib/roles";

export const maxDuration = 300;

/** POST {url?} → SSE progress; writes products.md. Admin and owner only (src/lib/roles.ts "catalog.import"). */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return new Response("unauthorized", { status: 401 });
  const no = forbid(u, "catalog.import");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { url?: string };
  const site = b.url || (await getBrand(sc(u)))?.website;
  if (!site) return new Response("no_site", { status: 400 });
  // Each import reads up to some forty pages of a site the caller names: the same six an hour per workspace as a store's
  // product import, in the same bucket (rule 2249).
  if (!(await allow(wsKey.catalogImportBucket(sc(u)), CATALOG_IMPORTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        const r = await importCatalog(sc(u), site, (m) => send({ progress: m }));
        send({ done: true, count: r.count, sample: r.products.slice(0, 5) });
      } catch (e) {
        send({ error: e instanceof Error ? e.message : "failed" });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
}
