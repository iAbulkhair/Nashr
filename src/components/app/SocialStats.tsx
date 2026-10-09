"use client";
import type { Lang } from "@/lib/i18n";
import type { Platform, PlatformPart, SocialPost, StoredSocial, Totals, XStats } from "@/lib/social-stats";
import type { NotReadItem, NotReadPlatform, NotReadReason } from "@/lib/not-read";
import { dateFormat } from "@/lib/dates";
import { pctChange, rate as rateOf, type N } from "@/lib/figures";
import RefreshButton from "./RefreshButton";

/**
 * The social card on Reports (spec section 8): one block per platform part from the last read (src/lib/social-stats.ts),
 * then X's last paid read (src/lib/x-stats.ts), each with its followers, its window's totals, the change against the
 * previous window where that was read, and its best posts; then the platforms not read (rule 738), the same items Dana's
 * reports list. Read only, and the same figures Dana's reports get; the page shows no model text. Names, captions and
 * account labels are the owner's or the public's text: React renders them as text, never as markup. A number not read
 * shows a dash, never zero. A snapshot from before v2 says the results have not been read yet (rule 737). The buttons
 * post the connect route's read actions; the route checks the role, the limit and the charge.
 */
const STR = {
  ar: {
    title: "نتائج السوشال", read: "آخر قراءة", followers: "المتابعون", reach28: "الوصول (28 يوماً)", views28: "المشاهدات (28 يوماً)",
    topPosts: "أفضل المنشورات", fromThakeen: "من ذكين", open: "افتح", views: "مشاهدات", reach: "وصول", likes: "إعجابات", comments: "تعليقات",
    notProfessional: "حساب إنستقرام ليس احترافياً، فلا نتائج له", liNoPage: "اربط صفحة شركة لترى نتائج لينكدإن",
    notReadYet: "نتائج السوشال لم تُقرأ بعد.", partNotRead: "لم يُقرأ بعد.",
    impressions28: "مرات الظهور (28 يوماً)", clicks: "النقرات", reactions: "الإعجابات", shares: "إعادة النشر", engagement: "معدل التفاعل", note: "تُحدَّث يومياً. دانة تستخدم هذه الأرقام في تقاريرها.", noteX: "تُحدَّث يومياً، وإكس فقط عند الضغط على «حدّث إكس». دانة تستخدم هذه الأرقام في تقاريرها.",
    vsPrev: "مقارنة بالفترة السابقة", prevWindow: "الفترة السابقة",
    pageViews: "مشاهدات الصفحة", watchMinutes: "دقائق المشاهدة", followsGained: "متابعون جدد", followsLost: "ألغوا المتابعة",
    notRead: "لم يُقرأ", notReadNote: "دانة تذكر هذه في تقاريرها على أنها لم تُقرأ.", sep: "، ",
    names: { instagram: "إنستقرام", facebook: "فيسبوك", linkedin: "لينكدإن", youtube: "يوتيوب", tiktok: "تيك توك", x: "إكس" },
    types: { IMAGE: "صورة", VIDEO: "فيديو", CAROUSEL_ALBUM: "ألبوم", REELS: "ريلز" } as Record<string, string>,
    nrNames: {
      instagram: "إنستقرام", facebook: "صفحة فيسبوك", linkedin: "صفحة لينكدإن", linkedin_ads: "إعلانات لينكدإن", youtube: "يوتيوب", tiktok: "تيك توك",
      tiktok_ads: "إعلانات تيك توك", x: "إكس", meta_ads: "إعلانات ميتا", snapchat_ads: "إعلانات سناب شات", snapchat_organic: "حساب سناب شات",
      google_analytics: "Google Analytics", search_console: "Search Console", google_ads: "إعلانات Google", google_business_profile: "الملف التجاري على Google",
    } satisfies Record<NotReadPlatform, string>,
    reasons: {
      not_connected: "غير مربوط", publish_only: "مربوط للنشر فقط، لا نقرأ نتائجه", reconnect: "أعد ربطه من صفحة التكاملات", choose_page: "اختر صفحة الشركة من صفحة التكاملات",
      refresh_x: "يُقرأ عند الضغط على «حدّث إكس» فقط", x_direct_only: "مربوط بطريقة لا نقرأ منها، فاربط إكس مباشرة",
      read_failed: "آخر قراءة لم تُرجع أرقاماً، ونحاول في القراءة القادمة", analytics_scope: "صلاحية الإحصاءات غير ممنوحة",
      closed_to_apps: "سناب شات لا يتيح هذه النتائج للتطبيقات الخارجية", waiting_approval: "بانتظار موافقة Google",
    } satisfies Record<NotReadReason, string>,
  },
  en: {
    title: "Social results", read: "Last read", followers: "Followers", reach28: "Reach (28 days)", views28: "Views (28 days)",
    topPosts: "Top posts", fromThakeen: "from Thakeen", open: "Open", views: "views", reach: "reach", likes: "likes", comments: "comments",
    notProfessional: "This Instagram account is not a professional account, so it has no results", liNoPage: "Connect a company page to see LinkedIn results",
    notReadYet: "Social results have not been read yet.", partNotRead: "has not been read yet.",
    impressions28: "Impressions (28 days)", clicks: "Clicks", reactions: "Reactions", shares: "Reposts", engagement: "Engagement rate", note: "Refreshed daily. Dana uses these figures in her reports.", noteX: "Refreshed daily; X only when someone presses Refresh X. Dana uses these figures in her reports.",
    vsPrev: "vs the previous period", prevWindow: "Previous period",
    pageViews: "page views", watchMinutes: "minutes watched", followsGained: "new followers", followsLost: "unfollows",
    notRead: "Not read", notReadNote: "Dana lists these in her reports as not read.", sep: ", ",
    names: { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok", x: "X" },
    types: { IMAGE: "Image", VIDEO: "Video", CAROUSEL_ALBUM: "Carousel", REELS: "Reel" } as Record<string, string>,
    nrNames: {
      instagram: "Instagram", facebook: "Facebook Page", linkedin: "LinkedIn page", linkedin_ads: "LinkedIn Ads", youtube: "YouTube", tiktok: "TikTok",
      tiktok_ads: "TikTok Ads", x: "X", meta_ads: "Meta Ads", snapchat_ads: "Snapchat Ads", snapchat_organic: "Snapchat account",
      google_analytics: "Google Analytics", search_console: "Search Console", google_ads: "Google Ads", google_business_profile: "Google Business Profile",
    } satisfies Record<NotReadPlatform, string>,
    reasons: {
      not_connected: "Not connected", publish_only: "connected for publishing only; its results are not read", reconnect: "connect it again on the Integrations page", choose_page: "choose the company page on the Integrations page",
      refresh_x: "read only when someone presses Refresh X", x_direct_only: "connected through a route we do not read, so connect X directly",
      read_failed: "the last read gave no figures; the next read tries again", analytics_scope: "the analytics permission is not granted",
      closed_to_apps: "Snapchat does not open these results to outside apps", waiting_approval: "waiting for Google's approval",
    } satisfies Record<NotReadReason, string>,
  },
} as const;

/**
 * The card's order, kept here so this client file imports only types from social-stats. It must list exactly `PLATFORMS`
 * there, in the same order: tests/social-analytics-social.test.ts renders a part of every platform and checks it.
 */
const ORDER: readonly Platform[] = ["instagram", "facebook", "linkedin", "youtube", "tiktok"];

/** Each platform's own post host, as its reader keeps it (instagram igUrl, fbUrl, ytUrl, ttUrl, X's status link). */
const HOSTS: Record<Platform | "x", readonly string[]> = {
  instagram: ["instagram.com", "www.instagram.com"], facebook: ["facebook.com", "www.facebook.com"], linkedin: ["linkedin.com", "www.linkedin.com"],
  youtube: ["www.youtube.com"], tiktok: ["tiktok.com", "www.tiktok.com"], x: ["x.com"],
};

/**
 * A post link only over https on its platform's own host, with no port and no credentials; anything else is dropped. The
 * readers keep only such links already: this is the page's own check, so a stored link from anywhere else never renders.
 */
export function postLink(platform: Platform | "x", url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && (HOSTS[platform] ?? []).includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The change against the previous window as a whole percent with its sign, only where both figures were read and the
 * previous one is above 0 (rule 733); otherwise null and nothing is shown.
 */
export function changeText(cur: N | undefined, prev: N | undefined): string | null {
  if (typeof cur !== "number" || typeof prev !== "number" || !(prev > 0)) return null;
  const n = Math.round(pctChange(cur, prev) ?? 0) || 0;
  return `${n > 0 ? "+" : ""}${n}%`;
}

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmt = (n: N | undefined) => (n == null ? "—" : NUM.format(n));
/** Best first: views, then reach; a post with neither read sorts last. */
const top = (posts: SocialPost[]) => [...posts].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.reach ?? -1) - (a.reach ?? -1)).slice(0, 5);
const pct = (n: number | null) => (n == null ? "—" : `${NUM.format(n * 100)}%`);
/** The known states that keep their own line on the card (the not-professional line, the company page line). */
const KNOWN_LINE: Partial<Record<NotReadPlatform, string>> = { instagram: "ig_not_professional", linkedin: "li_no_page_access" };
/** Figures some readers fill and others leave null: shown only where read. */
const EXTRA = ["pageViews", "watchMinutes", "followsGained", "followsLost"] as const satisfies readonly (keyof Totals)[];

type Props = {
  lang: Lang;
  social: StoredSocial | null;
  /** `getXStats` through `xReadOf`, without the account's id: X's last read, paid on a click (rule 744). */
  x?: XStats | null;
  /** `notReadOf` over the page's own reads (rule 738): every named platform with no read, each with its reason. */
  notRead?: readonly NotReadItem[];
  /** LinkedIn is connected through Composio with no company page chosen (report-sources.ts `liNeedsPage`). */
  liNoPage?: boolean;
  /** `can(u, "read")`: any member may refresh the social parts, free (rule 735). */
  canRefresh?: boolean;
  /** `socialRefreshPath`: the provider path `sync_social` posts to; null when no part can be read. */
  socialVia?: string | null;
  /** `can(u, "generate")`: X's refresh spends one of the account's credits (rule 744). */
  canRefreshX?: boolean;
  /** `xDirect`: X is connected directly and does not wait for a reconnect. */
  xConnected?: boolean;
  /** `noCreditsText`: the out-of-credits line for the viewer's role and plan (rule 457). */
  noCredits?: string;
};

export default function SocialStats({ lang, social, x = null, notRead = [], liNoPage = false, canRefresh = false, socialVia = null, canRefreshX = false, xConnected = false, noCredits }: Props) {
  const S = STR[lang];
  const v2 = social?.v === 2 ? social : null;
  const day = dateFormat(lang, { day: "numeric", month: "short", year: "numeric" });
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : day.format(d);
  };
  const when = v2 ? date(v2.at) : null;
  const tile = (label: string, value: string, sub?: string, delta?: string | null) => (
    <div className="rounded-lg border border-ink/10 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted" dir="ltr">{sub}</p>}
      {delta && <p className="mt-0.5 text-xs text-muted"><span dir="ltr">{delta}</span> {S.vsPrev}</p>}
    </div>
  );
  /** A figure in a line, with its change in brackets where there is one. */
  const figure = (cur: N, prev: N | undefined, label: string) => {
    const c = changeText(cur, prev);
    return <>{fmt(cur)}{c && ` (${c})`} {label}</>;
  };
  const range = (r: { from: string; to: string }) => `${r.from} → ${r.to}`;
  // X's reader falls back to the account "X" when neither the username nor the stored account is known: that only repeats the name.
  const head = (name: Platform | "x", account: string) => {
    const shown = name === "x" && (account === "X" || account === S.names.x) ? "" : account;
    return (
      <p className="text-sm font-semibold" dir="auto">
        {S.names[name]}
        {shown ? <> · {name === "instagram" ? <span dir="ltr">@{shown}</span> : name === "x" ? <span dir="ltr">{shown}</span> : shown}</> : null}
      </p>
    );
  };
  const postList = (posts: SocialPost[], name: Platform | "x") =>
    posts.length > 0 && (
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{S.topPosts}</p>
        <ul className="mt-1 grid gap-2 text-sm">
          {top(posts).map((p) => {
            const href = postLink(name, p.url);
            return (
              <li key={p.id} className="rounded-lg border border-ink/10 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span dir="ltr">{p.date} · {S.types[p.type] ?? p.type}</span>
                  {p.fromThakeen && <span className="rounded-full bg-ink/5 px-2 py-0.5">{S.fromThakeen}</span>}
                </div>
                <p className="mt-1" dir="auto">{p.caption}</p>
                <p className="mt-1 text-xs text-muted" dir="ltr">
                  {fmt(p.views)} {S.views} · {fmt(p.reach)} {S.reach} · {fmt(p.likes)} {S.likes} · {fmt(p.comments)} {S.comments}
                  {href && <> · <a href={href} rel="noopener noreferrer" target="_blank" className="underline">{S.open}</a></>}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    );
  const part = (p: PlatformPart, name: Platform) => {
    const t = p.totals;
    const pv = p.prev?.totals;
    const li = name === "linkedin";
    const extra = EXTRA.filter((k) => t[k] != null);
    return (
      <div key={name} data-platform={name} className="mt-4 first:mt-2">
        {head(name, p.account)}
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tile(S.followers, fmt(p.followers))}
          {name === "instagram" ? (
            <>{tile(S.reach28, fmt(t.reach), range(p.range), changeText(t.reach, pv?.reach))}{tile(S.views28, fmt(t.views), undefined, changeText(t.views, pv?.views))}</>
          ) : li ? (
            <>{tile(S.impressions28, fmt(t.views), range(p.range), changeText(t.views, pv?.views))}{tile(S.engagement, pct(rateOf(t)))}</>
          ) : (
            <>{tile(S.views28, fmt(t.views), range(p.range), changeText(t.views, pv?.views))}{tile(S.reach28, fmt(t.reach), undefined, changeText(t.reach, pv?.reach))}</>
          )}
        </div>
        {name !== "instagram" && (
          <p className="mt-2 text-xs text-muted" dir="ltr">
            {figure(t.clicks, pv?.clicks, S.clicks)} · {figure(t.likes, pv?.likes, li ? S.reactions : S.likes)} · {figure(t.comments, pv?.comments, S.comments)} · {figure(t.shares, pv?.shares, S.shares)}
          </p>
        )}
        {extra.length > 0 && (
          <p className="mt-1 text-xs text-muted" dir="ltr">
            {extra.map((k, i) => <span key={k}>{i > 0 && " · "}{figure(t[k], pv?.[k], S[k])}</span>)}
          </p>
        )}
        {p.prev && <p className="mt-1 text-xs text-muted">{S.prevWindow}: <span dir="ltr">{range(p.prev.range)}</span></p>}
        {postList(p.posts, name)}
      </div>
    );
  };
  const listed = (name: Platform) => notRead.some((i) => i.platform === name);
  // A known state keeps its own line; any other failure is said by the not-read list when it names the platform.
  const failed = (name: Platform, code: string) =>
    code === "li_no_page_access" || (code !== "ig_not_professional" && listed(name)) ? null : (
      <p key={`e-${name}`} className="mt-3 text-sm text-muted">
        {code === "ig_not_professional" ? S.notProfessional : `${S.names[name]} ${S.partNotRead}`}
      </p>
    );
  const choosePage = notRead.some((i) => i.platform === "linkedin" && i.reason === "choose_page");
  // A personal Instagram account or a company page the member does not administer already says why on its own line;
  // its `read_failed` item ("the next read tries again") would promise a fix a read cannot bring, so the card leaves it out.
  // Dana's NOT READ block keeps it (not-read.ts).
  const shownNotRead = notRead.filter((i) => !(i.reason === "read_failed" && KNOWN_LINE[i.platform] && v2?.errors?.[i.platform as Platform] === KNOWN_LINE[i.platform]));
  const unconnected = shownNotRead.filter((i) => i.reason === "not_connected");
  const other = shownNotRead.filter((i) => i.reason !== "not_connected");
  const refresh = canRefresh && !!socialVia;
  const refreshX = canRefreshX && xConnected;
  return (
    <div id="social-stats" className="card mt-6" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{S.title}</h2>
        {when && <p className="text-xs text-muted">{S.read}: {when}</p>}
      </div>
      {(refresh || refreshX) && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {refresh && socialVia && <RefreshButton lang={lang} kind="social" path={socialVia} />}
          {refreshX && <RefreshButton lang={lang} kind="x" path="x" noCredits={noCredits} />}
        </div>
      )}
      {social && !v2 && <p className="mt-3 text-sm text-muted">{S.notReadYet}</p>}
      {v2 && ORDER.map((name) => {
        const p = v2.parts[name];
        const code = v2.errors?.[name];
        return p ? part(p, name) : code ? failed(name, code) : null;
      })}
      {x && (
        <div data-platform="x" className="mt-4 first:mt-2">
          {head("x", x.account)}
          <p className="mt-0.5 text-xs text-muted">{S.read}: {date(x.at)}</p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">{tile(S.followers, fmt(x.followers))}</div>
          {postList(x.posts, "x")}
        </div>
      )}
      {(liNoPage || v2?.errors?.linkedin === "li_no_page_access") && !choosePage && <p className="mt-3 text-sm text-muted">{S.liNoPage}</p>}
      {shownNotRead.length > 0 && (
        <div data-not-read="" className="mt-4 border-t border-ink/10 pt-3">
          <p className="text-sm font-semibold">{S.notRead}</p>
          <ul className="mt-1 grid gap-1 text-sm text-muted">
            {other.map((i) => <li key={`${i.platform}-${i.reason}`}>{S.nrNames[i.platform]}: {S.reasons[i.reason]}</li>)}
            {unconnected.length > 0 && <li>{S.reasons.not_connected}: {unconnected.map((i) => S.nrNames[i.platform]).join(S.sep)}</li>}
          </ul>
          <p className="mt-1 text-xs text-muted">{S.notReadNote}</p>
        </div>
      )}
      {/* X is never in the daily read (rule 744): with its row or its button shown, the note says it is read only on a click. */}
      <p className="mt-3 text-xs text-muted">{x || refreshX ? S.noteX : S.note}</p>
    </div>
  );
}
