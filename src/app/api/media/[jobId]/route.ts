import { NextResponse, after } from "next/server";
import { currentUser, getUser, sc } from "@/lib/auth";
import { getTask } from "@/lib/brand";
import { allow, retryLater } from "@/lib/rate";
import { advance, getJob, maybeSweep, publicJob } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { deadlineFor } from "@/lib/media/keys";
import { errCode } from "@/lib/media/start";
import { acct } from "@/lib/account-id";

export const maxDuration = 120;

/**
 * The inbox polls a running render here (spec 4.4 E). The job is read only under the caller's own scope, so another
 * account's job id is a 404 and costs no provider call; the engine's 4 s throttle and job lock bound provider calls per job.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { jobId } = await ctx.params;
  // getJob refuses anything but 32 hex characters before a key is built from it.
  const found = await getJob(sc(u), jobId);
  if (!found) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(`mpoll:u:${u.email}`, 120, 60))) return retryLater({ ok: false, error: "slow_down", job: publicJob(found) }, 60);
  let job = found;
  try {
    job = await advance(found, mediaDeps(), { deadline, via: "poll" });
  } catch (e) {
    // A transient refund error leaves the job open for the next poll or sweep: answer with what is stored.
    console.error("media poll", errCode(e));
    job = (await getJob(sc(u), jobId).catch(() => null)) ?? found;
  }
  const [task, account] = await Promise.all([job.state === "done" ? getTask(sc(u), job.taskId) : null, job.state === "failed" ? getUser(acct(u)) : null]);
  after(() => maybeSweep(mediaDeps(), deadline));
  return NextResponse.json({ ok: true, job: publicJob(job), ...(task ? { task } : {}), ...(account ? { credits: account.credits } : {}) });
}
