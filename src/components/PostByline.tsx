import type { Lang } from "@/lib/i18n";
import { initials, type PostAuthor } from "@/lib/authors";

/**
 * The person a post is signed by (rule 3315): their initials in a round mark (there is no photo field), name and role, and the
 * name is a link to their own page when `content/authors.json` gives one. Drawn only for a post that names an author; the
 * rest keep the organisation byline in their structured data and show no person.
 */
export default function PostByline({ lang, author }: { lang: Lang; author: PostAuthor }) {
  const ar = lang === "ar";
  return (
    <div role="group" aria-label={ar ? "كاتب المقال" : "Post author"} className="mt-3 flex items-center gap-3" data-testid="post-byline">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong bg-background-muted text-sm font-bold">{initials(author.name)}</span>
      <span>
        <span className="block font-bold">
          {author.link ? (
            <a href={author.link} target="_blank" rel="noopener noreferrer" className="underline">{author.name}<span className="sr-only">{ar ? " (يفتح في تبويب جديد)" : " (opens in a new tab)"}</span></a>
          ) : author.name}
        </span>
        <span className="block text-sm text-foreground-muted">{author.role}</span>
      </span>
    </div>
  );
}
