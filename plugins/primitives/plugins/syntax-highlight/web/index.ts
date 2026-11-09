import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { getHighlighter, themeForMode } from "./internal/highlighter";
export { SHIKI_LANGS, languageForPath, resolveLang } from "./internal/lang";
export { useDarkMode } from "./internal/use-dark-mode";
export { HighlightedCode } from "./internal/highlighted-code";
export { JsonCode } from "./internal/json-code";
export {
  CodeListing,
  CodePaneSurface,
  type CodeListingProps,
  type CodeListingVariant,
} from "./internal/code-listing";
export { useHighlightedHtml } from "./internal/use-highlighted-html";
export type {
  HighlightedHtmlResult,
  UseHighlightedHtmlOptions,
} from "./internal/use-highlighted-html";

export default {
  description:
    "Shared shiki-based syntax highlighter primitive. Exposes getHighlighter, themeForMode, languageForPath, useDarkMode, a <HighlightedCode> component for plugins rendering code, <JsonCode> (a JSON value pretty-printed and coloured, multi-line strings written across lines), and <CodeListing> — the line-numbered listing (block or full-pane, optional highlighted line) behind transcript Read results and the file viewer's Code tab.",
  contributions: [],
} satisfies PluginDefinition;
