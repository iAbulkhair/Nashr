import type { Lang } from "@/lib/i18n";
import type { IgPost, SocialSnapshot } from "@/lib/social-stats";
import { dateFormat } from "@/lib/dates";

/**
 * The social card on Reports: the Instagram account and its best posts, and the LinkedIn page, from the last read
 * (src/lib/social-stats.ts). Read only, and the same figures Dana's reports get. Captions are the owner's or the public's
 * text: React renders them as text, never as markup. A number not read shows a dash, never zero.
 */
const STR = {
  ar: {
    title: "نتائج السوشال", read: "آخر قراءة", followers: "المتابعون", reach28: "الوصول (28 يوماً)", views28: "المشاهدات (28 يوماً)",
    topPosts: "أفضل المنشورات", fromThakeen: "من ذكين", open: "افتح", views: "مشاهدات", reach: "وصول", likes: "إعجابات", comments: "تعليقات",
    notProfessional: "حساب إنستقرام ليس احترافياً، فلا نتائج له", liNoPage: "اربط صفحة شركة لترى نتائج لينكدإن",
    noIg: "إنستقرام لم يُقرأ بعد.", note: "تُحدَّث يومياً. دانة تستخدم هذه الأرقام في تقاريرها.",
    types: { IMAGE: "صورة", VIDEO: "فيديو", CAROUSEL_ALBUM: "ألبوم", REELS: "ريلز" },
  },
  en: {
    title: "Social results", read: "Last read", followers: "Followers", reach28: "Reach (28 days)", views28: "Views (28 days)",
    topPosts: "Top posts", fromThakeen: "from Thakeen", open: "Open", views: "views", reach: "reach", likes: "likes", comments: "comments",
    notProfessional: "This Instagram account is not a professional account, so it has no results", liNoPage: "Connect a company page to see LinkedIn results",
    noIg: "Instagram has not been read yet.", note: "Refreshed daily. Dana uses these figures in her reports.",
    types: { IMAGE: "Image", VIDEO: "Video", CAROUSEL_ALBUM: "Carousel", REELS: "Reel" },
  },
} as const;

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmt = (n: number | null) => (n == null ? "—" : NUM.format(n));
/** Best first: views, then reach; a post with neither read sorts last. */
const top = (posts: IgPost[]) => [...posts].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.reach ?? -1) - (a.reach ?? -1)).slice(0, 5);

export default function SocialStats({ lang, social }: { lang: Lang; social: SocialSnapshot }) {
  const S = STR[lang];
  const when = dateFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(new Date(social.at));
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-ink/10 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted" dir="ltr">{sub}</p>}
    </div>
  );
  const ig = social.ig;
  return (
    <div id="social-stats" className="card mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{S.title}</h2>
        <p className="text-xs text-muted">{S.read}: {when}</p>
      </div>
      {ig ? (
        <>
          <p className="mt-2 text-sm font-semibold" dir="ltr">@{ig.user}</p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile(S.followers, fmt(ig.followers))}
            {tile(S.reach28, fmt(ig.reach), `${ig.range.from} → ${ig.range.to}`)}
            {tile(S.views28, fmt(ig.views))}
          </div>
          {ig.posts.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{S.topPosts}</p>
              <ul className="mt-1 grid gap-2 text-sm">
                {top(ig.posts).map((p) => (
                  <li key={p.id} className="rounded-lg border border-ink/10 p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <span dir="ltr">{p.at.slice(0, 10)} · {S.types[p.type]}</span>
                      {p.fromThakeen && <span className="rounded-full bg-ink/5 px-2 py-0.5">{S.fromThakeen}</span>}
                    </div>
                    <p className="mt-1" dir="auto">{p.caption}</p>
                    <p className="mt-1 text-xs text-muted" dir="ltr">
                      {fmt(p.views)} {S.views} · {fmt(p.reach)} {S.reach} · {fmt(p.likes)} {S.likes} · {fmt(p.comments)} {S.comments}
                      {p.url && <> · <a href={p.url} rel="noopener noreferrer" target="_blank" className="underline">{S.open}</a></>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : <p className="mt-3 text-sm text-muted">{social.igError === "ig_not_professional" ? S.notProfessional : S.noIg}</p>}
      {social.liError === "li_no_page_access" && <p className="mt-3 text-sm text-muted">{S.liNoPage}</p>}
      <p className="mt-3 text-xs text-muted">{S.note}</p>
    </div>
  );
}
