import type { MetadataRoute } from "next";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { PWA_BACKGROUND_TOKEN, PWA_ICONS, PWA_NAME, PWA_SHORT_NAME, PWA_START, PWA_THEME_TOKEN } from "@/lib/pwa";
import tokens from "../../assets/design-tokens.json";

/** A colour by design-token name, from the one source (src/app/tokens.css is kept from the same file). */
const color = (name: typeof PWA_THEME_TOKEN | typeof PWA_BACKGROUND_TOKEN) => tokens.primitive.color[name].$value;

/**
 * Web app manifest, served at /manifest.webmanifest and linked from every page (rule 681). Static: it holds no user data,
 * so it may be cached. Arabic first, like the default site: `lang` ar, `dir` rtl, the Arabic site description.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: PWA_START,
    name: PWA_NAME,
    short_name: PWA_SHORT_NAME,
    description: SITE_DEFAULT.ar.description,
    lang: "ar",
    dir: "rtl",
    start_url: PWA_START,
    scope: "/",
    display: "standalone",
    theme_color: color(PWA_THEME_TOKEN),
    background_color: color(PWA_BACKGROUND_TOKEN),
    icons: PWA_ICONS.map((i) => ({ ...i })),
  };
}
