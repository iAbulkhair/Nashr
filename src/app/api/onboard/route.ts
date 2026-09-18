import { track } from "@/lib/track";
import { currentUser, sc } from "@/lib/auth";
import { crawl } from "@/lib/crawl";
import { buildFromSite } from "@/lib/onboard";
import { saveBrand } from "@/lib/brand";
import { readFile, writeFile } from "@/lib/files";
import { push, type ChatMsg } from "@/lib/chat";
import { db } from "@/lib/db";

export const maxDuration = 300;

const T = {
  ar: { intro: "خلّيني أشوف موقعك وأبدأ أجهّز لك كل شيء.", crawl: "أقرأ محتوى موقعك", visuals: "أتعرّف على المنصة والألوان والخطوط", research: "أبحث في سوقك ومنافسيك", files: "أكتب ملفات مساحة العمل", plan: "أجهّز خطة البداية", unreachable: "لم أستطع فتح الموقع، سأبني من اسم النطاق ومما أعرفه عن مجالك. راجع الملفات وصحّح ما يلزم.", filesMsg: "هذه ملفات مساحة عملك. أرجع لها في كل مهمة، وتقدر تعدّلها من «الملفات» في أي وقت.", planTitle: "هذه خطتك" },
  en: { intro: "Let me take a look at your site and start putting things together.", crawl: "Reading your website", visuals: "Detecting the platform, colours and fonts", research: "Researching your market and competitors", files: "Writing your workspace files", plan: "Preparing your starter plan", unreachable: "I could not open the site, so I am building from the domain and what I know about your field. Review the files and correct what is off.", filesMsg: "These are your workspace files. I read them before every task, and you can edit them under Files at any time.", planTitle: "Here's your plan" },
} as const;

/**
 * First-run onboarding, run inside the "Getting started" thread (the default
 * conversation). POST {url, hints?} → text/event-stream in the chat protocol:
 * {type:"status",text} · {type:"message",message} (several) · {type:"done"} · {type:"error",error}.
 * Every message is also persisted, so a reload shows the same thread.
 * Free: onboarding never charges credits.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { url?: string; hints?: string };
  if (!b.url || b.url.trim().length < 4) return new Response("bad_url", { status: 400 });
  const scope = sc(u), t = T[u.lang === "en" ? "en" : "ar"];
  // One run at a time per workspace: a reload during the run must not start a second one.
  if (!(await db.lock(`onboardlock:${scope}`, 240))) return new Response("busy", { status: 409 });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* client went away; keep working so the thread is complete on reload */ } };
      const say = async (m: Omit<ChatMsg, "role" | "at" | "agent">) => { const msg: ChatMsg = { role: "assistant", agent: "noor", at: new Date().toISOString(), ...m }; await push(scope, msg); send({ type: "message", message: msg }); };
      let timer: ReturnType<typeof setInterval> | undefined;
      const beat = setInterval(() => { try { ctrl.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 10000);
      try {
        await say({ content: t.intro });
        send({ type: "status", text: t.crawl });
        const site = await crawl(b.url!);
        send({ type: "status", text: t.visuals });
        if (!site.ok) await say({ content: t.unreachable });
        // One model call does research, files and plan; surface its stages while it runs.
        const stages = [t.research, t.files, t.plan];
        let i = 0;
        send({ type: "status", text: stages[i++] });
        timer = setInterval(() => { if (i < stages.length) send({ type: "status", text: stages[i++] }); }, 25000);
        const r = await buildFromSite(site, u.lang, b.hints, u.email);
        clearInterval(timer);
        await track(u.email, "onboard");
        await saveBrand(scope, r.brand);
        const files: { name: string; content: string }[] = [];
        for (const f of r.files) { const saved = await writeFile(scope, f.name, f.content, "noor"); files.push({ name: saved.name, content: saved.content }); }
        if (!(await readFile(scope, "preferences.md"))) await writeFile(scope, "preferences.md", "# Preferences learned from the owner\n", "noor");
        await db.set(`onboardplan:${scope}`, { goal: r.goal, plan: r.plan, at: new Date().toISOString() });
        await say({ content: t.filesMsg, files });
        await say({ content: `**${t.planTitle}**\n\n${r.summary}`, plan: r.plan });
        send({ type: "done", brand: r.brand.name, goal: r.goal });
      } catch (e) {
        console.error("onboard failed", e);
        await track(u.email, "error").catch(() => {});
        send({ type: "error", error: e instanceof Error ? e.message.slice(0, 160) : "failed" });
      } finally {
        if (timer) clearInterval(timer);
        clearInterval(beat);
        await db.unlock(`onboardlock:${scope}`).catch(() => {});
        try { ctrl.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
