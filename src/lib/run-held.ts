import type { User } from "./auth";
import type { AgentId } from "./agents";
import { recordActivity } from "./activity";
import { systemBy } from "./actor";
import { acct } from "./account-id";
import { log } from "./log";
import { runClaim } from "./keys";

/**
 * Rule 2378: the owner's one notice, and one activity row, when a cron finds a paid scheduled run that was killed after
 * it began (src/lib/run-receipt.ts `held_now`). Nothing new was charged; a charge the killed run took is reused if the
 * owner runs it, and given back by the daily sweep if nobody does. The notice says so plainly and sends the owner to
 * Scheduled tasks, where the run waits for their Run. Never throws: the cron answers "held" either way.
 */
export async function tellHeld(user: User, scope: string, o: { claim: string; agent: AgentId; what: { ar: string; en: string } }): Promise<void> {
  const ar = user.lang === "ar";
  try {
    // notifications imports the schedule module, so it is loaded here, when needed (as schedule.ts does).
    const { brandTag, notifyItem, withBrand } = await import("./notifications");
    const tag = await brandTag(acct(user), scope).catch(() => "");
    await Promise.all([
      notifyItem(acct(user), user.lang, {
        kind: "info", agent: o.agent, href: "tasks",
        title: withBrand(ar ? `${o.what.ar} لم يكتمل` : `${o.what.en} did not finish`, tag),
        body: ar
          ? "توقف التشغيل قبل أن يكتمل، فلم نُعِده تلقائياً حتى لا يتكرر. لم يُخصم أي كريدت جديد، وما خُصم له يعود خلال يوم ما لم تشغّله. راجع صندوق الموافقة أولاً، ثم اضغط «شغّل الآن» في المهام المجدولة إن كنت تريده."
          : "The run stopped before it finished, so we did not run it again on our own. No new credits were used, and anything charged for it comes back within a day unless you run it. Check your inbox first, then press Run now in Scheduled tasks if you want it.",
      }, runClaim.heldNotice(o.claim), 14, scope),
      recordActivity(scope, [{ at: new Date().toISOString(), kind: "run_held", agent: o.agent, by: systemBy("cron"), via: "cron", outcome: "held" }]),
    ]);
  } catch (e) {
    log.error("held run notice failed", e);
  }
}
