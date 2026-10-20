"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { levelFor, type Journey, type LevelId, type MilestoneId } from "@/lib/journey";
import { Icon } from "./Icons";
import { JOURNEY_KEY, readStored, writeStored } from "@/lib/cookie-names";
import { useAppHref } from "@/components/app/WorkspaceContext";

const STR = {
  ar: {
    title: "مسار الانطلاق", level: "المستوى", points: "نقطة", of: "من", streak: (n: number) => (n === 1 ? "يوم متتالٍ" : n === 2 ? "يومان متتاليان" : n <= 10 ? `${n} أيام متتالية` : `${n} يوماً متتالياً`), streakHint: "أيام متتالية اعتمدت فيها أو رفضت محتوى",
    next: "الخطوة التالية", go: "ابدأ", done: "تمّ", locked: "لاحقاً", unlocked: "إنجاز جديد", levelUp: "ترقية المستوى", toLevel: (n: number) => `${n} للمستوى التالي`,
    complete: "وصلت الواحة: كل خطوات الانطلاق تمّت.", hide: "إخفاء", show: "عرض المسار", pointsNote: "النقاط للمتعة فقط، وليست رصيداً.",
    levels: { seed: "بذرة", sapling: "فسيلة", palm: "نخلة", oasis: "واحة" } as Record<LevelId, string>,
    m: {
      brand: ["نور قرأت علامتك", "ملف العلامة جاهز من موقعك."],
      guard: ["فعّل حارس العلامة", "أضف الكلمات الممنوعة. ذكين يمنع اعتماد أي نص يحتويها، في الكود وليس بالوعد."],
      approve: ["اعتمد أول منشور", "راجع مسودة واحدة من صندوق الموافقة واعتمدها."],
      schedule: ["ضع منشوراً في التقويم", "اختر تاريخ نشر لعنصر معتمد."],
      connect: ["اربط قناة", "واتساب أو إنستقرام أو متجرك، لتنشر بضغطة."],
      publish: ["انشر أول منشور", "من صندوق الموافقة إلى القناة مباشرة."],
      ai: ["علامتك داخل ChatGPT وClaude", "اربط ذكين بمساعدك، فيكتب بقواعد علامتك ويتحقق منها."],
    } as Record<MilestoneId, [string, string]>,
  },
  en: {
    title: "Launch path", level: "Level", points: "pts", of: "of", streak: (n: number) => `${n}-day streak`, streakHint: "Consecutive days you approved or rejected content",
    next: "Next step", go: "Start", done: "Done", locked: "Later", unlocked: "Milestone unlocked", levelUp: "Level up", toLevel: (n: number) => `${n} to next level`,
    complete: "Oasis reached: every launch step is done.", hide: "Hide", show: "Show path", pointsNote: "Points are for fun, not credits.",
    levels: { seed: "Seed", sapling: "Sapling", palm: "Palm", oasis: "Oasis" } as Record<LevelId, string>,
    m: {
      brand: ["Noor read your brand", "Your brand file is built from your site."],
      guard: ["Switch on the brand guard", "Add banned words. Thakeen refuses to approve text that contains one, in code, not by promise."],
      approve: ["Approve your first post", "Review one draft in the inbox and approve it."],
      schedule: ["Put a post on the calendar", "Pick a publish date for an approved item."],
      connect: ["Connect a channel", "WhatsApp, Instagram or your store, to publish in one click."],
      publish: ["Publish your first post", "Straight from the inbox to the channel."],
      ai: ["Your brand inside ChatGPT and Claude", "Connect Thakeen to your assistant so it writes to your rules and checks against them."],
    } as Record<MilestoneId, [string, string]>,
  },
} as const;

const ICON: Record<MilestoneId, string> = { brand: "folder", guard: "shield", approve: "thumbUp", schedule: "calendar", connect: "plug", publish: "send", ai: "spark" };
const COLORS = ["var(--color-primary)", "var(--color-accent)", "var(--color-danger)", "var(--color-foreground)", "var(--color-background-muted)"];

type Seen = { done: MilestoneId[]; level: LevelId; hidden?: boolean };
const read = (): Seen | null => { try { const v = readStored(localStorage, JOURNEY_KEY); return v ? (JSON.parse(v) as Seen) : null; } catch { return null; } };
const write = (s: Seen) => { try { writeStored(localStorage, JOURNEY_KEY, JSON.stringify(s)); } catch { /* private window: celebrations just repeat */ } };

/** Tell the card a milestone just happened in this tab (the inbox fires it after an approve, a date or a publish). */
export function milestone(id: MilestoneId) {
  window.dispatchEvent(new CustomEvent("nashr:milestone", { detail: id }));
}

function Confetti({ burst }: { burst: number }) {
  // Positions are fixed per burst so a re-render mid-fall does not scatter the pieces.
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => {
    const r = (n: number) => { const x = Math.sin(burst * 97 + i * 13.7 + n) * 43758.5453; return x - Math.floor(x); };
    return { left: `${r(1) * 100}%`, dx: `${(r(2) - 0.5) * 240}px`, rot: `${360 + r(3) * 720}deg`, delay: `${r(4) * 250}ms`, color: COLORS[i % COLORS.length], w: 6 + Math.round(r(5) * 5) };
  }), [burst]);
  if (!burst) return null;
  return <div className="confetti" aria-hidden>{pieces.map((p, i) => <i key={`${burst}-${i}`} style={{ left: p.left, background: p.color, width: p.w, animationDelay: p.delay, ["--dx" as string]: p.dx, ["--rot" as string]: p.rot } as React.CSSProperties} />)}</div>;
}

export default function JourneyCard({ journey, lang, compact = false }: { journey: Journey; lang: "ar" | "en"; compact?: boolean }) {
  const href = useAppHref(lang);
  const S = STR[lang];
  const base = href();
  const [extra, setExtra] = useState<MilestoneId[]>([]);
  const [toast, setToast] = useState<{ kind: "milestone" | "level"; text: string } | null>(null);
  const [burst, setBurst] = useState(0);
  const [hidden, setHidden] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextRef = useRef<HTMLAnchorElement | null>(null);

  // Milestones done on the server, plus any this tab just completed before the next server render.
  const milestones = journey.milestones.map((m) => (extra.includes(m.id) ? { ...m, done: true } : m));
  const doneCount = milestones.filter((m) => m.done).length;
  const points = milestones.filter((m) => m.done).reduce((s, m) => s + m.points, 0);
  const { level, nextAt, nextLevel } = levelFor(doneCount);
  const next = milestones.find((m) => !m.done);
  const pct = Math.round((doneCount / milestones.length) * 100);

  function celebrate(kind: "milestone" | "level", text: string) {
    setToast({ kind, text });
    setBurst((b) => b + 1);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3600);
  }

  // Compare with what this browser last saw: a milestone reached since then is celebrated once, a level change louder.
  const doneKey = milestones.filter((m) => m.done).map((m) => m.id).join(",");
  useEffect(() => {
    // Read after the first paint (storage is an external system, and the burst reads better once the page settles).
    const id = setTimeout(() => {
      const seen = read();
      const nowDone = doneKey ? (doneKey.split(",") as MilestoneId[]) : [];
      if (seen?.hidden) setHidden(true);
      // First visit in this browser: only the welcome milestone is celebrated, not every step done elsewhere.
      const fresh = seen ? nowDone.filter((m) => !seen.done.includes(m)) : nowDone.filter((m) => m === "brand");
      if (seen && seen.level !== level) celebrate("level", `${S.levelUp}: ${S.levels[level]}`);
      else if (fresh.length) celebrate("milestone", `${S.unlocked}: ${S.m[fresh[fresh.length - 1]][0]}`);
      write({ done: nowDone, level, hidden: seen?.hidden });
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the set of done milestones changes, by design
  }, [doneKey, level]);

  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<MilestoneId>).detail; setExtra((p) => (p.includes(id) ? p : [...p, id])); };
    window.addEventListener("nashr:milestone", on);
    return () => { window.removeEventListener("nashr:milestone", on); if (timer.current) clearTimeout(timer.current); };
  }, []);

  // On a phone the path scrolls sideways: bring the next step into view, without moving the page itself.
  useEffect(() => {
    const el = nextRef.current;
    const row = el?.closest("ol");
    if (!el || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollBy({ left: el.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - el.clientWidth) / 2 });
  }, [hidden]);

  const toggle = (h: boolean) => { setHidden(h); const s = read(); write({ done: s?.done ?? [], level: s?.level ?? level, hidden: h }); };

  const overlay = (
    <>
      <Confetti burst={burst} />
      {toast && (
        <div role="status" className="journey-toast flex items-center gap-3 rounded-2xl border-[1.5px] border-border-strong bg-surface px-4 py-3 text-sm">
          <span className="pop-in grid h-9 w-9 place-items-center rounded-full bg-inverse text-lemon"><Icon name={toast.kind === "level" ? level : "trophy"} className="h-5 w-5" /></span>
          <span className="font-semibold" dir="auto">{toast.text}</span>
        </div>
      )}
    </>
  );

  if (hidden) return <>{overlay}<button type="button" onClick={() => toggle(false)} className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground"><Icon name={level} className="h-4 w-4" />{S.levels[level]} · <span className="tnum" dir="ltr">{doneCount}/{milestones.length}</span> · {S.show}</button></>;

  return (
    <section className="card overflow-hidden p-0" aria-label={S.title}>
      {overlay}
      <header className="flex flex-wrap items-center gap-3 bg-inverse px-4 py-3 text-inverse-muted">
        <span className="pop-in grid h-11 w-11 shrink-0 place-items-center rounded-full bg-background-muted/10 text-lemon" key={level}><Icon name={level} className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-inverse-muted/70">{S.title}</p>
          <p className="font-display text-lg font-bold">{S.level}: {S.levels[level]}</p>
        </div>
        <div className="flex w-full items-center gap-2 text-xs sm:w-auto">
          {journey.streak > 0 && <span title={S.streakHint} className="flex items-center gap-1 rounded-full bg-lemon px-2.5 py-1 font-semibold text-accent-foreground"><Icon name="flame" className="h-3.5 w-3.5" /><span className="tnum">{S.streak(journey.streak)}</span></span>}
          <span title={S.pointsNote} className="rounded-full bg-background-muted/10 px-2.5 py-1 font-semibold"><span className="tnum" dir="ltr">{points} / {journey.maxPoints}</span> {S.points}</span>
          <button type="button" onClick={() => toggle(true)} className="ms-auto rounded-full px-2 py-1 text-inverse-muted/70 hover:text-inverse-muted" aria-label={S.hide}><Icon name="x" className="h-4 w-4" /></button>
        </div>
      </header>

      <div className="px-4 pt-3">
        <div className="journey-track" role="progressbar" aria-valuemin={0} aria-valuemax={milestones.length} aria-valuenow={doneCount}><div className="journey-fill" style={{ "--p": Math.max(4, pct) / 100 } as React.CSSProperties} /></div>
        <p className="mt-1.5 flex justify-between text-xs text-foreground-muted"><span className="tnum" dir="auto">{doneCount} {S.of} {milestones.length}</span>{nextAt && nextLevel && <span dir="auto">{S.toLevel(nextAt - doneCount)} · {S.levels[nextLevel]}</span>}</p>
      </div>

      {!compact && (
        <ol className="flex gap-1 overflow-x-auto px-2 py-2 sm:grid sm:grid-cols-7 sm:gap-0 sm:overflow-visible sm:px-3">
          {milestones.map((m, i) => {
            const isNext = next?.id === m.id;
            return (
              <li key={m.id} className="relative w-24 shrink-0 sm:w-auto">
                {/* The link from the previous milestone's centre to this one's. */}
                {i > 0 && <span aria-hidden className={`absolute top-7 hidden h-0.5 w-full sm:block ${m.done ? "bg-foreground" : "bg-foreground/10"}`} style={{ insetInlineEnd: "50%" }} />}
                <Link ref={isNext ? nextRef : undefined} href={`${base}${m.href}`} className={`relative flex flex-col items-center gap-1.5 rounded-lg p-2 text-center ${isNext ? "bg-lemon/10" : "hover:bg-background"}`}>
                  <span className={`relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 ${m.done ? "pop-in border-border-strong bg-inverse text-lemon" : isNext ? "journey-next border-border-strong bg-lemon text-accent-foreground" : "border-border bg-surface text-foreground-muted"}`}>
                    <Icon name={m.done ? "check" : isNext ? ICON[m.id] : "lock"} className="h-4.5 w-4.5" />
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-xs font-semibold leading-snug ${m.done ? "text-foreground" : isNext ? "text-foreground" : "text-foreground-muted"}`} dir="auto">{S.m[m.id][0]}</span>
                    <span className="tnum block text-[11px] text-foreground-muted" dir="ltr">+{m.points}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t border-foreground/5 bg-background px-4 py-3">
        {next ? (
          <>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lemon text-accent-foreground"><Icon name={ICON[next.id]} className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1 text-sm" dir="auto"><span className="block text-xs text-foreground-muted">{S.next} · <span className="tnum" dir="ltr">+{next.points}</span></span><span className="font-semibold">{S.m[next.id][0]}</span> <span className="text-foreground-muted">{S.m[next.id][1]}</span></span>
            <Link href={`${base}${next.href}`} className="btn btn-accent btn-xs">{S.go}</Link>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground" dir="auto"><Icon name="oasis" className="h-5 w-5 text-foreground" />{S.complete}</p>
        )}
      </footer>
    </section>
  );
}
