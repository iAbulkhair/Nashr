/**
 * Putting the Markdown copy of a page on the clipboard (rule 3317), for the "Copy page as Markdown" button. Client-side but
 * free of React and of the DOM types it does not need, so a test can pass fakes in. It asks for the text and tries, in order:
 *
 *  1. `navigator.clipboard.write` with a `ClipboardItem` whose content is the pending text: Safari only allows a clipboard
 *     write inside the click that asked for it, and the text arrives from the network after the click, so the write is made
 *     first and the text is handed to it as a promise;
 *  2. `navigator.clipboard.writeText` after the text arrived (Chrome and Firefox allow that);
 *  3. a hidden text field selected and copied with `document.execCommand("copy")`, for a browser without the clipboard API
 *     or on a page that is not a secure context.
 *
 * It says whether the copy worked and never throws, so the button can show "copied" or send the reader to the file.
 */
export type ClipboardEnv = {
  clipboard?: { writeText?: (s: string) => Promise<void>; write?: (items: unknown[]) => Promise<void> };
  ClipboardItem?: new (items: Record<string, Promise<Blob>>) => unknown;
  /** The page's document, for the text-field fallback. */
  document?: Pick<Document, "createElement" | "body" | "execCommand">;
};

/** The text of `href`, same origin, no cookies sent: the copy is public. Throws on anything but a 200. */
export async function fetchMarkdown(href: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(href, { credentials: "omit", headers: { Accept: "text/markdown" } });
  if (!res.ok) throw new Error(`markdown copy answered ${res.status}`);
  return res.text();
}

function copyWithField(text: string, doc: NonNullable<ClipboardEnv["document"]>): boolean {
  const field = doc.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  doc.body.appendChild(field);
  try {
    field.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export async function copyMarkdown(ask: () => Promise<string>, env: ClipboardEnv): Promise<boolean> {
  const { clipboard, ClipboardItem: Item } = env;
  // Asked once: a second step reuses the first answer, text or failure, instead of calling the network again.
  let asked: Promise<string> | undefined;
  const getText = () => (asked ??= ask());
  if (clipboard?.write && Item) {
    try {
      const pending = getText().then((t) => new Blob([t], { type: "text/plain" }));
      pending.catch(() => {}); // handled below by the next step, which reads the same answer
      await clipboard.write([new Item({ "text/plain": pending })]);
      return true;
    } catch {
      // Fall through: the browser refused the item form, or the text did not arrive. The next step reads the same answer.
    }
  }
  let text: string;
  try {
    text = await getText();
  } catch {
    return false;
  }
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no permission, not a secure context): try the field.
    }
  }
  return env.document ? copyWithField(text, env.document) : false;
}
