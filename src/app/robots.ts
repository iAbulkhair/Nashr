import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/origin";
const BASE = appOrigin();
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }], sitemap: `${BASE}/sitemap.xml` };
}
