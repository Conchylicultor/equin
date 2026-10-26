import { useEffect, useState } from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";
import { getHighlighter, themeForMode } from "./highlighter";

// Module-level memo of highlighted HTML, keyed by an opt-in cache key. shiki's
// `codeToHtml` is pure for a given (code, lang, theme, transformers), so a cached
// value is a STABLE string reference: every render — and every re-run of the
// effect below — reads back the exact same instance.
//
// That stability is load-bearing for consumers that inject the markup via
// `dangerouslySetInnerHTML` (e.g. HighlightedCode): React only re-commits when the
// `__html` string changes. Without the cache, a host that re-renders the code
// block (even with identical content) could hand React a fresh-but-equal html
// string, and React would tear down the `<pre>` and rebuild an identical one. That
// silent rebuild destroys any text selection inside the block and drops focus out
// of it — which then escapes the surrounding ContentScope, so Ctrl+A selects the
// whole document instead of the code. Returning a stable reference makes the render
// idempotent: identical inputs never touch the DOM.
//
// Caching is OPT-IN via `opts.cacheKey`: consumers that pass transformer sets which
// vary per render (line-number gutters etc.) leave it unset and recompute on every
// run, exactly as they did before this hook existed.
const htmlCache = new Map<string, string>();
const HTML_CACHE_MAX = 1000;

function rememberHtml(key: string, html: string): string {
  // Soft FIFO cap so the cache can't grow without bound across long transcripts.
  // An evicted-then-remounted block recomputes once — never a render loop.
  if (htmlCache.size >= HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(key, html);
  return html;
}

export interface UseHighlightedHtmlOptions {
  /**
   * `true` paints with the dark theme, `false` light. The caller owns the
   * dark-mode signal (typically `useDarkMode()`).
   */
  dark: boolean;
  /** Optional shiki transformers (line-number gutters, line highlight, …). */
  transformers?: ShikiTransformer[];
  /**
   * Optional pure post-processor applied to shiki's html (e.g. prepending a
   * `<style>` block). Must be referentially stable across renders for the same
   * inputs (define it at module scope or memoize it) — it participates in the
   * effect dependency list.
   */
  postProcess?: (html: string) => string;
  /**
   * Opt into the module-level html cache (stable string reference for identical
   * inputs — see the cache comment). Pass a key that fully discriminates the
   * (code, lang, theme, transformer-set) tuple. Leave unset to recompute every
   * run (the pre-hook behavior for transformer-driven consumers).
   */
  cacheKey?: string | null;
}

export interface HighlightedHtmlResult {
  /** The highlighted html, or `null` when there is nothing to render. */
  html: string | null;
  /** Stringified error from a failed highlight, or `null`. */
  error: string | null;
}

/**
 * Shared async-Shiki highlight effect. Folds the four near-identical
 * `getHighlighter().then(setHtml)` + cancel-flag effects (HighlightedCode,
 * RawView, CodeListing, CodeBlock) into one primitive. Returns
 * `{ html, error }`; consumers that don't distinguish errors read `html` and a
 * `null` html means "render the plain fallback".
 *
 * Pass `lang = null` (e.g. when `resolveLang` returns null) to skip highlighting
 * and get `{ html: null, error: null }`.
 */
export function useHighlightedHtml(
  code: string,
  lang: string | null,
  opts: UseHighlightedHtmlOptions,
): HighlightedHtmlResult {
  const { dark, transformers, postProcess } = opts;
  // Normalize the optional cache key to a single nullable so the effect deps and
  // every cache branch read the same value.
  const cacheKey = opts.cacheKey ?? null;
  const theme = themeForMode(dark);

  // Seed synchronously from the cache so a re-mount (or a host that re-creates the
  // component) paints the cached markup immediately — no fallback flash, same
  // string reference, so the host's `<pre>` is never rebuilt.
  const [html, setHtml] = useState<string | null>(() =>
    cacheKey != null ? (htmlCache.get(cacheKey) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- async-fetch-after-await: shiki getHighlighter() is async with no sync path; the cancel guard drops stale results so setHtml/setError can never write after unmount or an input change. The synchronous null-reset and cache-hit branches share this effect for coherence (same key deps) and are correct as effects — a live read (useLive) is for server data, not a pure client-side compute that never hits the network. */
    if (!lang || !code) {
      setHtml(null);
      setError(null);
      return;
    }
    if (cacheKey != null) {
      const cached = htmlCache.get(cacheKey);
      if (cached !== undefined) {
        // Stable reference → React bails out of the state update when unchanged.
        setHtml(cached);
        setError(null);
        return;
      }
    }
    let cancelled = false;
    getHighlighter(lang)
      .then((hl) => {
        if (cancelled) return;
        const raw = hl.codeToHtml(code, {
          lang: lang as BundledLanguage,
          theme,
          ...(transformers ? { transformers } : {}),
        });
        const out = postProcess ? postProcess(raw) : raw;
        setHtml(cacheKey != null ? rememberHtml(cacheKey, out) : out);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [code, lang, theme, transformers, postProcess, cacheKey]);

  return { html, error };
}
