import type { MetadataRoute } from "next";
import { LANGS } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { VS_SLUGS } from "@/lib/pages-vs";
import { postIndex } from "@/lib/blog";
import { AGENT_SLUGS } from "@/lib/site";

const BASE = process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  // `lastModified` is omitted rather than stamped with the build time. Every deploy used to re-date all 114 URLs,
  // including pages that had not changed in months, which tells a crawler nothing and teaches it to ignore the
  // field. Only the blog posts carry a real date, from their own front matter.
  const posts = new Map(postIndex().map((p) => [p.slug, p.date]));
  const paths: string[] = [];
  for (const l of LANGS) {
    paths.push(`/${l}`, `/${l}/pricing`, `/${l}/ai-marketing-agent`, `/${l}/tools`, `/${l}/blog`, `/${l}/affiliates`, `/${l}/affiliates/terms`, `/${l}/help`, `/${l}/privacy`, `/${l}/terms`);
    paths.push(`/${l}/agents`, `/${l}/customers`, `/${l}/enterprise`, `/${l}/resources`, `/${l}/updates`);
    for (const a of AGENT_SLUGS) paths.push(`/${l}/agents/${a}`);
    for (const t of TOOLS) paths.push(`/${l}/tools/${t.slug}`);
    for (const s of INDUSTRY_SLUGS) paths.push(`/${l}/for/${s}`);
    for (const s of VS_SLUGS) paths.push(`/${l}/vs/${s}`);
    for (const p of posts.keys()) paths.push(`/${l}/blog/${p}`);
  }
  return paths.map((p) => {
    const date = posts.get(p.split("/blog/")[1] ?? "");
    return {
      url: BASE + p,
      ...(date ? { lastModified: new Date(`${date}T00:00:00Z`) } : {}),
      changeFrequency: p.includes("/blog") ? ("weekly" as const) : ("monthly" as const),
      priority: p.split("/").length <= 2 ? 1 : 0.7,
    };
  });
}
