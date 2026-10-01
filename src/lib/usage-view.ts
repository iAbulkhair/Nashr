/**
 * What the owner is shown about their consumption (rule 315): how long the credits and the chat messages last at the
 * current pace. Pure and import-free on purpose: the profile panel (a client component) and the billing page both read
 * it, and anything imported here would be dragged into their bundles (tests/client-bundle.test.ts).
 *
 * Dates come back as `YYYY-MM-DD` (UTC), the way the app already writes `nextReset` and `trialEnds`: no locale
 * formatter, so the server and every browser render the same text (tests/date-locale.test.ts).
 *
 * Pinned by tests/usage-view.test.ts.
 */

export const DAY_MS = 864e5;

/**
 * - `unused`: nothing used yet in this period, so there is no pace to project.
 * - `out`: nothing left (used up, or an allowance of 0).
 * - `lasts`: at the average daily pace so far, what is left reaches the end of the period.
 * - `runs_out`: at that pace it is used up before the period ends, around `on` (YYYY-MM-DD).
 */
export type Runway = { kind: "unused" } | { kind: "out" } | { kind: "lasts" } | { kind: "runs_out"; on: string };

export type RunwayInput = {
  /** Used so far in this period. Not a finite number, or below 0, reads as 0. */
  used: number;
  /** What is left now. Not a finite number, or below 0, reads as 0. */
  left: number;
  /** When the period being measured started (the pace is `used` over the days since). */
  periodStart: Date | string | number;
  /** When the allowance renews; null on a trial, which ends at `trialEnds` instead. */
  resetAt: Date | string | number | null;
  /** The trial's end, used when `resetAt` is null. */
  trialEnds?: Date | string | number | null;
  /** Defaults to the current time. */
  now?: Date | string | number;
};

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const time = (v: Date | string | number | null | undefined): number => (v === null || v === undefined ? NaN : new Date(v).getTime());

/**
 * The runway, or null when the dates cannot be read or the period already ended (nothing honest to say: a trial past its
 * end must not "last until" a day that is gone). The pace is `used` over the days since `periodStart`, counted as at
 * least one day: an hour into the month, ten messages would otherwise project hundreds a day. A result on or after the
 * period's end is `lasts`; with no readable end at all, the date is given as is.
 */
export function runway(i: RunwayInput): Runway | null {
  const used = count(i.used);
  const left = count(i.left);
  if (left <= 0) return { kind: "out" };
  if (used <= 0) return { kind: "unused" };
  const start = time(i.periodStart);
  const now = time(i.now ?? Date.now());
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  const end = time(i.resetAt ?? i.trialEnds ?? null);
  if (Number.isFinite(end) && end <= now) return null;
  const perDay = used / Math.max(1, (now - start) / DAY_MS);
  const runsOut = now + (left / perDay) * DAY_MS;
  if (Number.isFinite(end) && runsOut >= end) return { kind: "lasts" };
  const d = new Date(runsOut);
  if (!Number.isFinite(d.getTime())) return Number.isFinite(end) ? { kind: "lasts" } : null;
  return { kind: "runs_out", on: d.toISOString().slice(0, 10) };
}

export type RunwayLineOptions = {
  lang: string;
  /** Whose runway: the credit balance or the chat messages. */
  what: "credits" | "messages";
  /** A trial ends at `trialEnds` and is never renewed. */
  trial: boolean;
  /** YYYY-MM-DD: the next renewal (the 1st, UTC). */
  nextReset: string;
  /** YYYY-MM-DD: the trial's last day. */
  trialEnds: string;
  /** Messages only, paid plans: the owner turned "continue on credits" on. */
  overflowOn?: boolean;
  /**
   * Messages only: the account has no chat messages at all (a founder override of 0) and does not continue on credits,
   * so nothing renews and no date is promised.
   */
  chatOff?: boolean;
  /**
   * Messages only, with `overflowOn`: the balance is below this many credits, the least a message on credits needs
   * (`ChatStatus.overflow.hold`), so chat is paused rather than continuing on credits.
   */
  shortOf?: number;
};

/**
 * The sentence the profile and the billing page show under a bar, in Arabic or English; null when there is nothing to
 * say (nothing used yet, or unreadable dates). Every number and date in it comes from the arguments.
 */
export function runwayLine(r: Runway | null, o: RunwayLineOptions): string | null {
  if (!r || r.kind === "unused") return null;
  const ar = o.lang === "ar";
  const credits = o.what === "credits";
  if (r.kind === "out") {
    if (credits) return o.trial ? (ar ? "نفد كريدت التجربة." : "The trial's credits are used up.") : (ar ? `نفد الرصيد حتى التجديد في ${o.nextReset}.` : `The credits are used up until the renewal on ${o.nextReset}.`);
    if (o.chatOff && !o.overflowOn) return ar ? "الدردشة غير متاحة في هذا الحساب. تواصل مع الدعم." : "Chat is not available on this account. Contact support.";
    if (o.trial) return ar ? "استُخدمت رسائل التجربة: الدردشة متوقفة حتى تفعيل الاشتراك." : "The trial's messages are used up: chat is paused until a subscription is activated.";
    if (o.overflowOn && typeof o.shortOf === "number" && o.shortOf > 0) {
      return ar
        ? `استُخدمت رسائل هذا الشهر، والدردشة متوقفة: رصيدك أقل من ${o.shortOf} كريدت، وهو أقل ما تحتاجه الرسالة على الكريدت.`
        : `This month's messages are used up, and chat is paused: your balance is below the ${o.shortOf} credits a message on credits needs.`;
    }
    return o.overflowOn
      ? (ar ? "استُخدمت رسائل هذا الشهر: الدردشة مستمرة على الكريدت حتى التجديد." : "This month's messages are used up: chat continues on credits until the renewal.")
      : (ar ? `استُخدمت رسائل هذا الشهر: الدردشة متوقفة حتى ${o.nextReset}.` : `This month's messages are used up: chat is paused until ${o.nextReset}.`);
  }
  if (r.kind === "lasts") {
    if (credits) return o.trial ? (ar ? `بهذا المعدل يكفي رصيدك حتى نهاية التجربة في ${o.trialEnds}.` : `At this pace your credits last until your trial ends on ${o.trialEnds}.`) : (ar ? `بهذا المعدل يكفي رصيدك حتى التجديد في ${o.nextReset}.` : `At this pace your credits last until the renewal on ${o.nextReset}.`);
    return o.trial ? (ar ? `بهذا المعدل تكفي رسائلك حتى نهاية التجربة في ${o.trialEnds}.` : `At this pace your messages last until your trial ends on ${o.trialEnds}.`) : (ar ? `بهذا المعدل تكفي رسائلك حتى التجديد في ${o.nextReset}.` : `At this pace your messages last until the renewal on ${o.nextReset}.`);
  }
  if (credits) return ar ? `بهذا المعدل ينفد رصيدك نحو ${r.on}.` : `At this pace your credits run out around ${r.on}.`;
  if (o.trial) return ar ? `بهذا المعدل تنفد رسائلك نحو ${r.on}.` : `At this pace your messages run out around ${r.on}.`;
  return o.overflowOn
    ? (ar ? `بهذا المعدل تنفد رسائلك نحو ${r.on}، ثم تستمر الدردشة على الكريدت.` : `At this pace your messages run out around ${r.on}, then chat continues on credits.`)
    : (ar ? `بهذا المعدل تنفد رسائلك نحو ${r.on}، ثم تتوقف الدردشة حتى ${o.nextReset}.` : `At this pace your messages run out around ${r.on}, then chat pauses until ${o.nextReset}.`);
}

/** 00:00 UTC on the 1st of the month `now` falls in: when the monthly credits and chat messages renew. */
export function monthStartUtc(now: Date | string | number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * When this period's usage started counting: the month's start, or the account's creation when that is later (a trial,
 * or an account opened this month). An unreadable `createdAt` falls back to the month's start.
 */
export function paceStart(createdAt: Date | string | number | null | undefined, now: Date | string | number = Date.now()): Date {
  const month = monthStartUtc(now);
  const created = time(createdAt);
  return Number.isFinite(created) && created > month.getTime() ? new Date(created) : month;
}
