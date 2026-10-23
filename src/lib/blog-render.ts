import type { Lang } from "./i18n";
import { render } from "./md";
import { highlightCode } from "./md-highlight";
import { appOrigin } from "./origin";

/**
 * A post's Markdown as the HTML the blog page, and later the help page, shows (rules 3311, 3312): through the one `render`
 * in src/lib/md.ts, with the page's language (so `/pricing` becomes `/ar/pricing`), this site's origin (so an absolute link
 * to it is an internal one) and the server-side code highlighter. Server only, because of the highlighter.
 */
export const renderPost = (lang: Lang, body: string): string => render(body, { lang, origin: appOrigin(), highlight: highlightCode });
