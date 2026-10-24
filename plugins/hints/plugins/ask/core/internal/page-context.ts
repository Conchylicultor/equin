import type { AskInput } from "./input";

/**
 * The `<page-context>` token: where the user was when they sent a reply from
 * another page than the agent last heard of — the same fields as the run's
 * first context (`AskInput`), carried in the turn's own text so the agent
 * reads it with the words it came with. Attributes for the page, the outline
 * as the body (multi-line: its indentation is its tree).
 *
 * ```
 * <page-context app="pages" app-name="Pages" path="/pages/p/…" title="Roadmap">
 * …the outline…
 * </page-context>
 * ```
 */
export const PAGE_CONTEXT_TAG = "page-context";

/** One `<page-context …>…</page-context>` token, attributes and body. */
export const PAGE_CONTEXT_RE =
  /<page-context(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?<\/page-context>/g;

const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const OPEN_RE = /^<page-context((?:\s+[\w-]+="[^"]*")*)\s*>/;

// Quote-delimited: only `"` would end a value early.
const attr = (v: string) => v.replace(/"/g, "'").replace(/\s+/g, " ").trim();

/** The page fields a chip names, read back off a token. */
export type PageContextPage = Pick<
  AskInput,
  "app" | "appName" | "path" | "title"
>;

/** `input` as a token, to append to the turn the user sends. */
export function formatPageContext(input: AskInput): string {
  const attrs = [
    input.app === null ? "" : ` app="${attr(input.app)}"`,
    input.appName === null ? "" : ` app-name="${attr(input.appName)}"`,
    ` path="${attr(input.path)}"`,
    input.title === null ? "" : ` title="${attr(input.title)}"`,
  ].join("");
  // A closing tag inside the outline (a control named after one) would end
  // the token early.
  const outline = input.outline.replaceAll(
    `</${PAGE_CONTEXT_TAG}`,
    `<\\/${PAGE_CONTEXT_TAG}`,
  );
  return `<${PAGE_CONTEXT_TAG}${attrs}>\n${outline}\n</${PAGE_CONTEXT_TAG}>`;
}

/** The page a token names; null for a token without a path. */
export function parsePageContext(token: string): PageContextPage | null {
  const open = OPEN_RE.exec(token);
  if (!open) return null;
  const attrs = new Map<string, string>();
  for (const [, k, v] of open[1]!.matchAll(ATTR_RE)) attrs.set(k!, v!);
  const path = attrs.get("path");
  if (!path) return null;
  return {
    app: attrs.get("app") || null,
    appName: attrs.get("app-name") || null,
    path,
    title: attrs.get("title") || null,
  };
}

/** `text` without its page-context tokens (a turn's text sent back to the draft). */
export function stripPageContext(text: string): string {
  return text.replace(PAGE_CONTEXT_RE, "").trimEnd();
}

/**
 * Which page `input` is, as a comparable key: the app, the route and the tab's
 * title — a new page is a new key, a re-render of the same one is not (the
 * outline is left out: it shifts with every popover and hover).
 */
export function pageKey(input: PageContextPage): string {
  return JSON.stringify([input.app, input.path, input.title]);
}
