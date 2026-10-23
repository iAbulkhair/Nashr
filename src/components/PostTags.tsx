import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import { blogHref, isActiveTag } from "@/lib/blog-tags";
import Scribble from "./Scribble";

/**
 * Blog tags as plain links (rule 3140): each is an address, `/{lang}/blog?tag=...`, that the server renders filtered, so
 * the filter works with no script of our own and can be shared, bookmarked and opened in a new tab. The active one carries
 * `aria-current="page"`. Used by the blog index (with an "all posts" link first) and by a post under its title.
 */
export function PostTags({ lang, tags, active, label, allLabel }: { lang: Lang; tags: string[]; active?: string; label: string; allLabel?: string }) {
  if (!tags.length) return null;
  return (
    <nav aria-label={label} className="mt-6 flex flex-wrap items-center gap-3">
      {allLabel !== undefined && (
        <Link href={blogHref(lang)} className="s-chip inline-flex items-center" aria-current={active ? undefined : "page"}>
          <Scribble kind="pill" seed="blog-tag-all" fill="paper" ring />{allLabel}
        </Link>
      )}
      {tags.map((tag) => (
        <Link key={tag} href={blogHref(lang, tag)} className="s-chip inline-flex items-center" aria-current={isActiveTag(tag, active) ? "page" : undefined}>
          <Scribble kind="pill" seed={`blog-tag-${tag}`} fill="paper" ring />{tag}
        </Link>
      ))}
    </nav>
  );
}
