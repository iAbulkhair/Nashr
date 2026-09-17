import type { MetadataRoute } from "next";
const BASE = process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }], sitemap: `${BASE}/sitemap.xml` };
}
