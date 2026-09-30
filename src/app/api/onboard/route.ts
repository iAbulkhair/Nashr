import { track } from "@/lib/track";
import { currentUser, sc, trialOver, type User } from "@/lib/auth";
import { crawl } from "@/lib/crawl";
import { buildFromSite } from "@/lib/onboard";
import { getBrand, saveBrand } from "@/lib/brand";
import { allow } from "@/lib/rate";
import { readFile, writeFile } from "@/lib/files";
import { push, type ChatMsg } from "@/lib/chat";
import { db } from "@/lib/db";
import { modelState } from "@/lib/model";
import { clearOnboard, confirmedOnboard, heldOnboard, onboardUrl } from "@/lib/onboard-confirm";
import { forbid } from "@/lib/roles";
import { agentSpendFor, capOf, chargeOnboard, refundOnboard, settleOnboard } from "@/lib/credits";
import { getGov } from "@/lib/governance";
import { warnAgentCap } from "@/lib/notifications";
import { onboardCost } from "@/lib/pricing";

export const maxDuration = 300;
/**
 * The run lock outlives the longest run the platform allows, so a second run can only start once the first is over (or
 * was killed): with a shorter lock a slow first run and a reload's second run built side by side on one charge. Released
 * with its owner token (`unlockOwned`), so a finished run can never free a newer run's lock.
 */
const LOCK_TTL = maxDuration + 30;

const T = {
  ar: { intro: "خلّيني أشوف موقعك وأبدأ أجهّز لك كل شيء.", crawl: "أقرأ محتوى موقعك", visuals: "أتعرّف على المنصة والألوان والخطوط", research: "أبحث في سوقك ومنافسيك", files: "أكتب ملفات مساحة العمل", plan: "أجهّز خطة البداية", unreachable: "لم أستطع فتح الموقع، سأبني من اسم النطاق ومما أعرفه عن مجالك. راجع الملفات وصحّح ما يلزم.", filesMsg: "هذه ملفات مساحة عملك. أرجع لها في كل مهمة، وتقدر تعدّلها من «الملفات» في أي وقت.", planTitle: "هذه خطتك" },
  en: { intro: "Let me take a look at your site and start putting things together.", crawl: "Reading your website", visuals: "Detecting the platform, colours and fonts", research: "Researching your market and competitors", files: "Writing your workspace files", plan: "Preparing your starter plan", unreachable: "I could not open the site, so I am building from the domain and what I know about your field. Review the files and correct what is off.", filesMsg: "These are your workspace files. I read them before every task, and you can edit them under Files at any time.", planTitle: "Here's your plan" },
} as const;

/** A refusal to pay, as JSON and before any stream: ChatPanel reads the status and the body's `error`. */
const owe = (error: "no_credits" | "trial_over" | "agent_cap", need: number, credits: number, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, error, need, credits, ...extra }, { status: 402 });

/**
 * What the ledger would refuse, read from the account as the request found it, so a certain refusal is answered before
 * the daily allowance and the lock (it costs none of the three tries). The ledger checks the same things again, in the
 * same order, inside its lock (src/lib/credits.ts `charge`): this only answers early.
 */
function cannotPay(u: User, cost: number, scope: string, noorCap: number | undefined): Response | null {
  if (trialOver(u)) return owe("trial_over", cost, u.credits);
  const cap = capOf(noorCap);
  const spent = agentSpendFor(u, scope).noor ?? 0;
  if (cap !== undefined && spent + cost > cap) return owe("agent_cap", cost, u.credits, { agent: "noor", spent, cap });
  if (!(Number.isFinite(u.credits) && u.credits >= cost)) return owe("no_credits", cost, Number.isFinite(u.credits) ? u.credits : 0);
  return null;
}

/**
 * Onboarding, run inside the "Getting started" thread (the default
 * conversation). POST {url, hints?} → text/event-stream in the chat protocol:
 * {type:"status",text} · {type:"message",message} (several) · {type:"done",credits} · {type:"error",error,refunded?,credits?,saved?}.
 * Every message is also persisted, so a reload shows the same thread. Builds only from the URL the owner confirmed
 * (src/lib/onboard-confirm.ts).
 *
 * The first brand (the default scope) is free. A second or later brand costs ONBOARD_EXTRA_BRAND_COST credits
 * (src/lib/pricing.ts `onboardCost`), charged to Noor in that brand's scope under her monthly cap there, after every
 * other refusal and under the run's lock, before the stream starts: a refusal to pay is a 402 JSON answer and never a
 * stream. The charge is held on the account record in the same save as the debit (src/lib/credits.ts `chargeOnboard`):
 * a retry reuses a held charge instead of paying twice, the refund of a build that failed before the brand was saved
 * gives it back and drops the hold in one save (so it can happen once), and the daily cron refunds a hold nobody used for
 * a day. A failure after the brand file was saved is not refunded (the brand was delivered) and says so (`saved`).
 * Charged in mock mode too, like /api/generate. Rule 226, tests/brand-guardrails.test.ts.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return new Response("unauthorized", { status: 401 });
  // Onboarding writes the brand file and the core memory: admin and owner only (src/lib/roles.ts "onboard").
  const no = forbid(u, "onboard");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { url?: unknown; hints?: string };
  const url = onboardUrl(b.url);
  if (url.length < 4) return new Response("bad_url", { status: 400 });
  const scope = sc(u), t = T[u.lang === "en" ? "en" : "ar"];
  // Computed from the session's brand, never from the request: the default brand is free, any other pays.
  const cost = onboardCost(u.brandId);
  const marker = cost > 0 ? heldOnboard(u, scope) : null;
  const [brand, confirmed, gov] = await Promise.all([getBrand(scope), confirmedOnboard(scope), cost > 0 ? getGov(scope) : Promise.resolve(null)]);
  // Backed by a large model: run once per workspace and at most three times a day per account.
  if (brand) return new Response("already_onboarded", { status: 409 });
  // Only the site the owner confirmed on the start page (POST /api/onboard/confirm). A link someone else sent can
  // pre-fill that page but cannot choose what this workspace is built from: nothing below runs for it.
  if (confirmed !== url) return new Response("unconfirmed", { status: 403 });
  // Before the daily allowance and the lock, so a paused run costs the owner none of their three tries.
  if (modelState() === "paused") return new Response("paused", { status: 503 });
  // An added brand that cannot be paid for is refused here, for the same reason. A run already paid for is not asked again.
  if (cost > 0 && !marker) {
    const refusal = cannotPay(u, cost, scope, gov?.agentCaps.noor);
    if (refusal) return refusal;
  }
  if (!(await allow(`onboard:${u.email}`, 3, 86400))) return new Response("slow_down", { status: 429 });
  // One run at a time per workspace: a reload during the run must not start a second one.
  const lockKey = `onboardlock:${scope}`;
  const token = await db.lockOwned(lockKey, LOCK_TTL);
  if (!token) return new Response("busy", { status: 409 });
  const release = () => db.unlockOwned(lockKey, token).catch(() => {});
  // Read again under the lock: a run that finished between the reads above and the lock saved the brand and used up
  // the confirmation, and building again would overwrite that brand.
  const [built, stillConfirmed] = await Promise.all([getBrand(scope), confirmedOnboard(scope)]);
  if (built) { await release(); return new Response("already_onboarded", { status: 409 }); }
  if (stillConfirmed !== url) { await release(); return new Response("unconfirmed", { status: 403 }); }
  // Whether this run holds a charge: one it took now, or one a run that did not finish took (reused, never charged twice).
  let held = false;
  if (cost > 0) {
    const c = await chargeOnboard(u.email, cost, { scope, agent: "noor", cap: gov?.agentCaps.noor }).catch(async (e) => { await release(); throw e; });
    if (!c.ok) {
      await release();
      return c.reason === "agent_cap" ? owe("agent_cap", cost, c.credits, { agent: c.agent, spent: c.spent, cap: c.cap }) : owe(c.reason, cost, c.credits);
    }
    held = true;
    u.credits = c.credits;
    if (!c.reused) await warnAgentCap(u, c);
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* client went away; keep working so the thread is complete on reload */ } };
      const say = async (m: Omit<ChatMsg, "role" | "at" | "agent">) => { const msg: ChatMsg = { role: "assistant", agent: "noor", at: new Date().toISOString(), ...m }; await push(scope, msg); send({ type: "message", message: msg }); };
      const beat = setInterval(() => { try { ctrl.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 10000);
      // Set right after the brand file is saved: from then on the owner has the brand they paid for, and nothing is refunded.
      let brandSaved = false;
      try {
        await say({ content: t.intro });
        send({ type: "status", text: t.crawl });
        const site = await crawl(url);
        send({ type: "status", text: t.visuals });
        if (!site.ok) await say({ content: t.unreachable });
        // Three model calls run side by side (src/lib/onboard.ts). The status line moves when a part really lands.
        const stages = [t.research, t.files, t.plan];
        let landed = 0;
        send({ type: "status", text: stages[0] });
        const r = await buildFromSite(site, u.lang, b.hints, u.email, () => { landed++; if (landed < stages.length) send({ type: "status", text: stages[landed] }); });
        await track(u.email, "onboard");
        await saveBrand(scope, r.brand);
        brandSaved = true;
        const [saved, prefs] = await Promise.all([
          Promise.all(r.files.map((f) => writeFile(scope, f.name, f.content, "noor"))),
          readFile(scope, "preferences.md"),
          db.set(`onboardplan:${scope}`, { goal: r.goal, plan: r.plan, at: new Date().toISOString() }),
          clearOnboard(scope),
          held ? settleOnboard(u.email, scope) : Promise.resolve(),
        ]);
        const files = saved.map((f) => ({ name: f.name, content: f.content }));
        if (!prefs) await writeFile(scope, "preferences.md", "# Preferences learned from the owner\n", "noor");
        await say({ content: t.filesMsg, files });
        await say({ content: `**${t.planTitle}**\n\n${r.summary}`, plan: r.plan });
        send({ type: "done", brand: r.brand.name, goal: r.goal, credits: u.credits });
      } catch (e) {
        console.error("onboard failed", e);
        await track(u.email, "error").catch(() => {});
        let refunded: { credits: number; refunded: number } | null = null;
        if (held && !brandSaved) {
          // No brand, so nothing was delivered: the held credits go back and the hold with them, in one save, so the next
          // confirmed run pays afresh. Null when another run already refunded it: nothing is given back twice. When the
          // refund fails the hold stays: the next run reuses it, or the daily sweep refunds it.
          refunded = await refundOnboard(u.email, scope).catch((err) => (console.error("onboard refund failed", err instanceof Error ? err.name : "error"), null));
          if (refunded) u.credits = refunded.credits;
        } else if (held) {
          // The brand file was saved, so the owner has the brand they paid for: the charge stands and the hold goes.
          await settleOnboard(u.email, scope).catch((err) => console.error("onboard hold drop failed", err instanceof Error ? err.name : "error"));
        }
        send({ type: "error", error: e instanceof Error ? e.message.slice(0, 160) : "failed", ...(refunded ? { refunded: refunded.refunded, credits: refunded.credits } : {}), ...(brandSaved ? { saved: true } : {}) });
      } finally {
        clearInterval(beat);
        await release();
        try { ctrl.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
