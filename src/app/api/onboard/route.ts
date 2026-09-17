import { currentUser, sc } from "@/lib/auth";
import { crawl } from "@/lib/crawl";
import { buildFromSite } from "@/lib/onboard";
import { saveBrand } from "@/lib/brand";
import { readFile, writeFile } from "@/lib/files";

export const maxDuration = 300;

/** POST {url, hints?} → text/event-stream of {step, status, file?} events. */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { url?: string; hints?: string };
  if (!b.url || b.url.trim().length < 4) return new Response("bad_url", { status: 400 });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        send({ step: "crawl", status: "running" });
        const site = await crawl(b.url!);
        send({ step: "crawl", status: site.ok ? "done" : "warn", detail: site.ok ? `${site.platform !== "unknown" ? site.platform + " · " : ""}${site.title || site.url}` : `Site unreachable (${site.error}). Building from the domain and your hints.` });
        send({ step: "research", status: "running" });
        send({ step: "brand", status: "running" });
        const r = await buildFromSite(site, u.lang, b.hints);
        send({ step: "research", status: "done" });
        await saveBrand(sc(u), r.brand);
        send({ step: "brand", status: "done", brand: r.brand });
        for (const f of r.files) {
          const saved = await writeFile(sc(u), f.name, f.content, "noor");
          send({ step: "file", status: "done", file: { name: saved.name, content: saved.content } });
        }
        if (!(await readFile(sc(u), "preferences.md"))) {
          await writeFile(sc(u), "preferences.md", "# Preferences learned from the owner\n", "noor");
        }
        send({ step: "complete", status: "done" });
      } catch (e) {
        console.error("onboard failed", e);
        send({ step: "error", status: "error", detail: e instanceof Error ? e.message : "failed" });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
