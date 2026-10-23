import type { MetadataRoute } from "next";
import { LANGS, type Lang } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { postIndex } from "@/lib/blog";
import { AGENT_SLUGS } from "@/lib/site";
import { HELP, helpLangs } from "@/lib/help";
import { appOrigin } from "@/lib/origin";
import { isStaging } from "@/lib/deploy-env";

const BASE = appOrigin();

export default function sitemap(): MetadataRoute.Sitemap {
  // Staging is never indexed (rule 677): an empty sitemap, built statically like robots, so set `APP_ENV=staging` before the build.
  if (isStaging()) return [];
  // `lastModified` is omitted rather than stamped with the build time. Every deploy used to re-date all 114 URLs,
  // including pages that had not changed in months, which tells a crawler nothing and teaches it to ignore the
  // field. Only the blog posts carry a real date, from their own front matter.
  const index = postIndex();
  const posts = new Map(index.map((p) => [p.slug, p.date]));
  // Rule 3313: a post written in one language is listed once, at that language's address; the other language's address serves
  // the same text with a canonical pointing here, and is not a URL of its own to a crawler.
  const postLangs = new Map(index.map((p) => [p.slug, p.langs]));
  const paths: string[] = [];
  for (const l of LANGS) {
    paths.push(`/${l}`, `/${l}/pricing`, `/${l}/ai-marketing-agent`, `/${l}/tools`, `/${l}/blog`, `/${l}/affiliates`, `/${l}/affiliates/terms`, `/${l}/help`, `/${l}/privacy`, `/${l}/terms`);
    paths.push(`/${l}/agents`, `/${l}/customers`, `/${l}/enterprise`, `/${l}/resources`, `/${l}/updates`, `/${l}/compare`);
    for (const a of AGENT_SLUGS) paths.push(`/${l}/agents/${a}`);
    for (const t of TOOLS) paths.push(`/${l}/tools/${t.slug}`);
    // One page per help topic (rule 2144); an answer is a `#slug` on its topic page, so it has no URL of its own here.
    for (const t of HELP) if (helpLangs(t).includes(l)) paths.push(`/${l}/help/${t.id}`);
    for (const s of INDUSTRY_SLUGS) paths.push(`/${l}/for/${s}`);
    for (const p of posts.keys()) if (postLangs.get(p)!.includes(l)) paths.push(`/${l}/blog/${p}`);
  }
  return paths.map((p) => {
    const date = posts.get(p.split("/blog/")[1] ?? "");
    // hreflang (rule 1876): every page exists in both languages, so each URL names its Arabic and English twin and
    // Arabic as the default for a reader whose language is neither.
    const rest = p.replace(/^\/(ar|en)/, "");
    // A page in one language (rule 3313) names only that language: an alternate for a language it lacks would send a reader to a notice page.
    const post = rest.startsWith("/blog/") ? postLangs.get(rest.slice(6)) : undefined;
    const topic = rest.startsWith("/help/") ? HELP.find((t) => t.id === rest.slice(6)) : undefined;
    const have: readonly Lang[] = post ?? (topic ? helpLangs(topic) : LANGS);
    const languages: Record<string, string> = Object.fromEntries(have.map((x) => [x, `${BASE}/${x}${rest}`]));
    languages["x-default"] = `${BASE}/${have[0]}${rest}`;
    return {
      url: BASE + p,
      alternates: { languages },
      ...(date ? { lastModified: new Date(`${date}T00:00:00Z`) } : {}),
      changeFrequency: p.includes("/blog") ? ("weekly" as const) : ("monthly" as const),
      priority: p.split("/").length <= 2 ? 1 : 0.7,
    };
  });
}
