import type { PostCover as Cover } from "@/lib/blog-cover";

/**
 * The picture at the top of a post (rule 3314): its own cover, or with none its generated share card. A fixed 1200 by 630
 * frame (the card's size, so a cover of that size is shown whole) keeps the page from moving when the image arrives; a cover
 * of another shape is cropped to it, never stretched. The generated card repeats the title the page shows above it, so it
 * has an empty alternative text and a screen reader skips it.
 */
export default function PostCover({ cover }: { cover: Cover }) {
  return (
    <figure className="mt-8" data-testid="post-cover" data-generated={cover.generated ? "" : undefined}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a file of our own under public/blog, or our own generated share card */}
      <img src={cover.src} alt={cover.alt} width={1200} height={630} decoding="async" className="aspect-[1200/630] w-full border-[1.5px] border-border-strong object-cover" />
    </figure>
  );
}
