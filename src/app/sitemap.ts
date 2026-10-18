import type { MetadataRoute } from "next";
import { LANGS } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { postIndex } from "@/lib/blog";
import { AGENT_SLUGS } from "@/lib/site";
import { HELP } from "@/lib/help";
import { appOrigin } from "@/lib/origin";
import { isStaging } from "@/lib/deploy-env";

const BASE = appOrigin();

export default function sitemap(): MetadataRoute.Sitemap {
  // Staging is never indexed (rule 677): an empty sitemap, built statically like robots, so set `APP_ENV=staging` before the build.
  if (isStaging()) return [];
  // `lastModified` is omitted rather than stamped with the build time. Every deploy used to re-date all 114 URLs,
  // including pages that had not changed in months, which tells a crawler nothing and teaches it to ignore the
  // field. Only the blog posts carry a real date, from their own front matter.
  const posts = new Map(postIndex().map((p) => [p.slug, p.date]));
  const paths: string[] = [];
  for (const l of LANGS) {
    paths.push(`/${l}`, `/${l}/pricing`, `/${l}/ai-marketing-agent`, `/${l}/tools`, `/${l}/blog`, `/${l}/affiliates`, `/${l}/affiliates/terms`, `/${l}/help`, `/${l}/privacy`, `/${l}/terms`);
    paths.push(`/${l}/agents`, `/${l}/customers`, `/${l}/enterprise`, `/${l}/resources`, `/${l}/updates`, `/${l}/compare`);
    for (const a of AGENT_SLUGS) paths.push(`/${l}/agents/${a}`);
    for (const t of TOOLS) paths.push(`/${l}/tools/${t.slug}`);
    // One page per help topic (rule 2144); an answer is a `#slug` on its topic page, so it has no URL of its own here.
    for (const t of HELP) paths.push(`/${l}/help/${t.id}`);
    for (const s of INDUSTRY_SLUGS) paths.push(`/${l}/for/${s}`);
    for (const p of posts.keys()) paths.push(`/${l}/blog/${p}`);
  }
  return paths.map((p) => {
    const date = posts.get(p.split("/blog/")[1] ?? "");
    // hreflang (rule 1876): every page exists in both languages, so each URL names its Arabic and English twin and
    // Arabic as the default for a reader whose language is neither.
    const rest = p.replace(/^\/(ar|en)/, "");
    return {
      url: BASE + p,
      alternates: { languages: { ar: `${BASE}/ar${rest}`, en: `${BASE}/en${rest}`, "x-default": `${BASE}/ar${rest}` } },
      ...(date ? { lastModified: new Date(`${date}T00:00:00Z`) } : {}),
      changeFrequency: p.includes("/blog") ? ("weekly" as const) : ("monthly" as const),
      priority: p.split("/").length <= 2 ? 1 : 0.7,
    };
  });
}
