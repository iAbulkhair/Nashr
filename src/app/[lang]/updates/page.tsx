import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { CHANGELOG, UPDATES, type ChangeEntry, type ChangeTag, type WishStatus } from "@/lib/changelog";
import { listWishes } from "@/lib/wishlist";
import { dateFormat } from "@/lib/dates";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import WishVote from "@/components/WishVote";
import WishSuggest from "@/components/WishSuggest";
import Scribble from "@/components/Scribble";
import { pageMeta } from "@/lib/page-meta";

// Vote counts and the viewer's own votes are read on every request and rendered on the server, so the page is right
// with no script at all; the vote button only takes over once it hydrates.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const c = UPDATES[lang];
  return pageMeta(lang, "/updates", { title: `${c.eyebrow} — ${dict[lang].brand}`, description: c.sub });
}

const TAG_CLASS: Record<ChangeTag, string> = { new: "badge badge-accent", improved: "badge badge-primary", fixed: "badge bg-background" };
const STATUS_CLASS: Record<WishStatus, string> = { planned: "badge bg-surface", in_progress: "badge badge-accent", shipped: "badge badge-primary" };

/** Entries that share a date, newest date first (CHANGELOG is already newest first). */
function byDate(entries: readonly ChangeEntry[]) {
  const out: { date: string; items: ChangeEntry[] }[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.date === e.date) last.items.push(e);
    else out.push({ date: e.date, items: [e] });
  }
  return out;
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], c = UPDATES[lang];
  const u = await currentUser();
  const wishes = await listWishes(u?.email);
  const fmt = dateFormat(lang, { day: "numeric", month: "long", year: "numeric" });
  const loginHref = `/${lang}/app/login?next=${encodeURIComponent(`/${lang}/updates`)}`;
  const voteLabels = { vote: c.vote, voted: c.voted, votesLabel: c.votesLabel, failed: c.failed, slowDown: c.slowDown };

  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="section-wrap">
          <p className="eyebrow">{c.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="updates-h" />
              {c.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{c.sub}</p>
        </section>

        {/* Section tabs: plain anchors, so both sections work without JavaScript. */}
        <nav aria-label={c.eyebrow} className="border-y-[1.5px] border-border-strong">
          <div className="mx-auto flex max-w-4xl gap-3 overflow-x-auto px-4 py-3 sm:px-6">
            <a href="#whats-new" className="s-chip inline-flex items-center whitespace-nowrap"><Scribble kind="pill" seed="updates-tab-new" fill="paper" ring />{c.tabNew}</a>
            <a href="#wishlist" className="s-chip inline-flex items-center whitespace-nowrap"><Scribble kind="pill" seed="updates-tab-wish" fill="paper" ring />{c.tabWish} <span className="tnum ms-1 text-foreground-muted" dir="ltr">{wishes.length}</span></a>
          </div>
        </nav>

        <section id="whats-new" className="mx-auto max-w-4xl scroll-mt-20 px-4 py-14 sm:px-6">
          <h2 className="section-title">{c.newTitle}</h2>
          <p className="mt-2 text-foreground-muted">{c.newSub}</p>
          <ol className="mt-8 grid gap-8">
            {byDate(CHANGELOG).map((g) => (
              <li key={g.date} className="grid gap-3 sm:grid-cols-[10rem_1fr] sm:gap-6">
                <h3 className="text-sm font-bold text-foreground-muted sm:pt-1"><time dateTime={g.date}>{fmt.format(new Date(`${g.date}T00:00:00Z`))}</time></h3>
                <ul className="grid divide-y divide-foreground/15 border-s-[1.5px] border-border-strong ps-4">
                  {g.items.map((e) => (
                    <li key={e.title.en} className="py-3 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={TAG_CLASS[e.tag]}>{c.tags[e.tag]}</span>
                        <h4 className="font-display text-base font-bold">{e.title[lang]}</h4>
                      </div>
                      <p className="mt-1.5 text-sm text-foreground-muted">{e.desc[lang]}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>

        <section id="wishlist" className="scroll-mt-20 border-t-[1.5px] border-border-strong bg-background-muted">
          <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
            <h2 className="section-title">{c.wishTitle}</h2>
            <p className="mt-2">{c.wishSub}</p>
            {!u && (
              <p className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                <span>{c.signInNote}</span>
                <Link href={loginHref} className="s-btn !min-h-10 !px-5 !text-base"><Scribble kind="pill" seed="updates-signin" fill="ink" shadow ring />{c.signIn}</Link>
              </p>
            )}
            {wishes.length === 0 ? <p className="mt-6 text-sm text-foreground-muted">{c.empty}</p> : (
              <ul className="mt-6 grid divide-y divide-foreground/15 border-y-[1.5px] border-border-strong">
                {wishes.map((w) => (
                  <li key={w.id} className="flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display text-base font-bold" dir="auto">{w.title[lang]}</h3>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                        <span className={STATUS_CLASS[w.status]}>{c.statuses[w.status]}</span>
                        {w.area && <span>{c.areas[w.area]}</span>}
                      </p>
                    </div>
                    {u ? (
                      <WishVote id={w.id} votes={w.votes} voted={w.voted} title={w.title[lang]} labels={voteLabels} loginHref={loginHref} />
                    ) : (
                      <Link href={loginHref} aria-label={`${c.signIn}: ${w.title[lang]}`} className="flex min-w-16 shrink-0 flex-col items-center rounded-xl border-[1.5px] border-border-strong bg-surface px-3 py-1.5 text-sm font-bold hover:bg-lemon">
                        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        <span className="tnum" dir="ltr">{w.votes}</span>
                        <span className="text-xs font-medium">{c.votesLabel}</span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-8">
              {u ? (
                <WishSuggest lang={lang} labels={{ title: c.suggestTitle, sub: c.suggestSub, placeholder: c.suggestPlaceholder, send: c.suggestSend, sent: c.suggestSent, note: c.suggestPrivate, tooShort: c.tooShort, tooLong: c.tooLong, failed: c.failed, slowDown: c.suggestSlowDown }} />
              ) : (
                <div className="s-card">
                  <Scribble kind="box" seed="updates-suggest" fill="paper" />
                  <h3 className="font-display text-lg font-bold">{c.suggestTitle}</h3>
                  <p className="mt-1 text-sm text-foreground-muted">{c.suggestPrivate}</p>
                  <Link href={loginHref} className="mt-3 inline-block font-bold text-foreground underline">{c.signInSuggest}</Link>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
