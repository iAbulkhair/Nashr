import type { Lang } from "@/lib/i18n";
import type { Platform, PlatformPart, SocialPost, StoredSocial } from "@/lib/social-stats";
import { dateFormat } from "@/lib/dates";

/**
 * The social card on Reports: one block per platform part from the last read (src/lib/social-stats.ts), each with its
 * followers, its window's totals and its best posts. Read only, and the same figures Dana's reports get. Names and
 * captions are the owner's or the public's text: React renders them as text, never as markup. A number not read shows a
 * dash, never zero. A snapshot from before v2 says the results have not been read yet (rule 737).
 */
const STR = {
  ar: {
    title: "نتائج السوشال", read: "آخر قراءة", followers: "المتابعون", reach28: "الوصول (28 يوماً)", views28: "المشاهدات (28 يوماً)",
    topPosts: "أفضل المنشورات", fromThakeen: "من ذكين", open: "افتح", views: "مشاهدات", reach: "وصول", likes: "إعجابات", comments: "تعليقات",
    notProfessional: "حساب إنستقرام ليس احترافياً، فلا نتائج له", liNoPage: "اربط صفحة شركة لترى نتائج لينكدإن",
    notReadYet: "نتائج السوشال لم تُقرأ بعد.", partNotRead: "لم يُقرأ بعد.",
    impressions28: "مرات الظهور (28 يوماً)", clicks: "النقرات", reactions: "الإعجابات", shares: "إعادة النشر", engagement: "معدل التفاعل", note: "تُحدَّث يومياً. دانة تستخدم هذه الأرقام في تقاريرها.",
    names: { instagram: "إنستقرام", facebook: "فيسبوك", linkedin: "لينكدإن", youtube: "يوتيوب", tiktok: "تيك توك" },
    types: { IMAGE: "صورة", VIDEO: "فيديو", CAROUSEL_ALBUM: "ألبوم", REELS: "ريلز" } as Record<string, string>,
  },
  en: {
    title: "Social results", read: "Last read", followers: "Followers", reach28: "Reach (28 days)", views28: "Views (28 days)",
    topPosts: "Top posts", fromThakeen: "from Thakeen", open: "Open", views: "views", reach: "reach", likes: "likes", comments: "comments",
    notProfessional: "This Instagram account is not a professional account, so it has no results", liNoPage: "Connect a company page to see LinkedIn results",
    notReadYet: "Social results have not been read yet.", partNotRead: "has not been read yet.",
    impressions28: "Impressions (28 days)", clicks: "Clicks", reactions: "Reactions", shares: "Reposts", engagement: "Engagement rate", note: "Refreshed daily. Dana uses these figures in her reports.",
    names: { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok" },
    types: { IMAGE: "Image", VIDEO: "Video", CAROUSEL_ALBUM: "Carousel", REELS: "Reel" } as Record<string, string>,
  },
} as const;

/** The card's order, kept here so this client file imports only types from social-stats (PLATFORMS there). */
const ORDER: readonly Platform[] = ["instagram", "facebook", "linkedin", "youtube", "tiktok"];

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmt = (n: number | null) => (n == null ? "—" : NUM.format(n));
/** Best first: views, then reach; a post with neither read sorts last. */
const top = (posts: SocialPost[]) => [...posts].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.reach ?? -1) - (a.reach ?? -1)).slice(0, 5);

const pct = (n: number | null) => (n == null ? "—" : `${NUM.format(n * 100)}%`);
/** Engagements over views; a dash when either was not read or views are 0. */
const rate = (p: PlatformPart) => (p.totals.engagements != null && p.totals.views ? p.totals.engagements / p.totals.views : null);

/** `liNoPage`: LinkedIn is connected through Composio with no company page chosen (report-sources.ts `liNeedsPage`). */
export default function SocialStats({ lang, social, liNoPage = false }: { lang: Lang; social: StoredSocial | null; liNoPage?: boolean }) {
  const S = STR[lang];
  const v2 = social?.v === 2 ? social : null;
  const when = v2 ? dateFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(new Date(v2.at)) : null;
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-ink/10 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted" dir="ltr">{sub}</p>}
    </div>
  );
  const range = (p: PlatformPart) => `${p.range.from} → ${p.range.to}`;
  const part = (p: PlatformPart, name: Platform) => {
    const t = p.totals;
    const li = name === "linkedin";
    return (
      <div key={name} className="mt-4 first:mt-2">
        <p className="text-sm font-semibold" dir="auto">
          {S.names[name]} · {name === "instagram" ? <span dir="ltr">@{p.account}</span> : p.account}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tile(S.followers, fmt(p.followers))}
          {name === "instagram" ? (
            <>{tile(S.reach28, fmt(t.reach), range(p))}{tile(S.views28, fmt(t.views))}</>
          ) : li ? (
            <>{tile(S.impressions28, fmt(t.views), range(p))}{tile(S.engagement, pct(rate(p)))}</>
          ) : (
            <>{tile(S.views28, fmt(t.views), range(p))}{tile(S.reach28, fmt(t.reach))}</>
          )}
        </div>
        {name !== "instagram" && (
          <p className="mt-2 text-xs text-muted" dir="ltr">
            {fmt(t.clicks)} {S.clicks} · {fmt(t.likes)} {li ? S.reactions : S.likes} · {fmt(t.comments)} {S.comments} · {fmt(t.shares)} {S.shares}
          </p>
        )}
        {p.posts.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{S.topPosts}</p>
            <ul className="mt-1 grid gap-2 text-sm">
              {top(p.posts).map((x) => (
                <li key={x.id} className="rounded-lg border border-ink/10 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span dir="ltr">{x.date} · {S.types[x.type] ?? x.type}</span>
                    {x.fromThakeen && <span className="rounded-full bg-ink/5 px-2 py-0.5">{S.fromThakeen}</span>}
                  </div>
                  <p className="mt-1" dir="auto">{x.caption}</p>
                  <p className="mt-1 text-xs text-muted" dir="ltr">
                    {fmt(x.views)} {S.views} · {fmt(x.reach)} {S.reach} · {fmt(x.likes)} {S.likes} · {fmt(x.comments)} {S.comments}
                    {x.url && <> · <a href={x.url} rel="noopener noreferrer" target="_blank" className="underline">{S.open}</a></>}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };
  const failed = (name: Platform, code: string) =>
    code === "li_no_page_access" ? null : (
      <p key={`e-${name}`} className="mt-3 text-sm text-muted">
        {code === "ig_not_professional" ? S.notProfessional : `${S.names[name]} ${S.partNotRead}`}
      </p>
    );
  return (
    <div id="social-stats" className="card mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{S.title}</h2>
        {when && <p className="text-xs text-muted">{S.read}: {when}</p>}
      </div>
      {social && !v2 && <p className="mt-3 text-sm text-muted">{S.notReadYet}</p>}
      {v2 && ORDER.map((name) => {
        const p = v2.parts[name];
        const code = v2.errors?.[name];
        return p ? part(p, name) : code ? failed(name, code) : null;
      })}
      {(liNoPage || v2?.errors?.linkedin === "li_no_page_access") && <p className="mt-3 text-sm text-muted">{S.liNoPage}</p>}
      <p className="mt-3 text-xs text-muted">{S.note}</p>
    </div>
  );
}
