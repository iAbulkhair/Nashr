import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import nord from "shiki/themes/nord.mjs";
import bash from "shiki/langs/shellscript.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import type { CodeHighlighter, CodeToken } from "./md";

/**
 * Syntax highlighting for fenced code in a post (rule 3311), done on the server when the page is built or rendered, never
 * in the browser: the page ships coloured text and no highlighter. Shiki (the `shiki` package, an exact version) with its
 * pure JavaScript regex engine, so there is no WebAssembly file to load and the highlighter is built synchronously once.
 * Only the languages below are loaded, with the `nord` theme (the one supastarter's blog uses); a fence in any other
 * language, or with no language, is still a code block, in one colour.
 *
 * Shiki only splits the code into tokens. What reaches the page is built by `render` in src/lib/md.ts, which escapes every
 * token and accepts a colour only as `#hex`, so nothing a post contains can write markup, and a post's code is never run
 * (a post is Markdown, not MDX). This file must not be imported by a client component.
 */
const THEME = "nord";
const LANGS = [bash, css, diff, html, javascript, json, jsx, markdown, python, sql, tsx, typescript, yaml];

let shiki: ReturnType<typeof createHighlighterCoreSync> | undefined;
const get = () => (shiki ??= createHighlighterCoreSync({ themes: [nord], langs: LANGS, engine: createJavaScriptRegexEngine() }));

/** True when `lang` (a fence's language name or alias, such as `ts` or `sh`) is one the highlighter loaded. */
export const knowsLanguage = (lang: string): boolean => get().getLoadedLanguages().includes(lang.toLowerCase());

/** The `CodeHighlighter` `render` takes: tokens per line, or null for a language that was not loaded. */
export const highlightCode: CodeHighlighter = (code, lang) => {
  const h = get();
  if (!knowsLanguage(lang)) return null;
  return h.codeToTokensBase(code, { lang: lang.toLowerCase(), theme: THEME }).map((line) => line.map((t): CodeToken => ({ text: t.content, color: t.color })));
};
