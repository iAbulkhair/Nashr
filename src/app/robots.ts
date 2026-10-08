import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/origin";
import { isStaging } from "@/lib/deploy-env";
const BASE = appOrigin();
export default function robots(): MetadataRoute.Robots {
  // Staging is never indexed (rule 677): everything disallowed and no sitemap line. This file is built statically,
  // so `APP_ENV=staging` has to be set before the staging build, not only before `next start`.
  if (isStaging()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }], sitemap: `${BASE}/sitemap.xml` };
}
