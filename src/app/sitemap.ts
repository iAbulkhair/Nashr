import type { MetadataRoute } from "next";
import { LANGS } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { VS_SLUGS } from "@/lib/pages-vs";
import { slugs } from "@/lib/blog";

const BASE = process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const paths: string[] = [];
  for (const l of LANGS) {
    paths.push(`/${l}`, `/${l}/pricing`, `/${l}/ai-marketing-agent`, `/${l}/tools`, `/${l}/blog`, `/${l}/affiliates`, `/${l}/help`, `/${l}/privacy`, `/${l}/terms`);
    for (const t of TOOLS) paths.push(`/${l}/tools/${t.slug}`);
    for (const s of INDUSTRY_SLUGS) paths.push(`/${l}/for/${s}`);
    for (const s of VS_SLUGS) paths.push(`/${l}/vs/${s}`);
    for (const s of slugs()) paths.push(`/${l}/blog/${s}`);
  }
  return paths.map((p) => ({ url: BASE + p, lastModified: now, changeFrequency: p.includes("/blog") ? "weekly" : "monthly", priority: p.split("/").length <= 2 ? 1 : 0.7 }));
}
