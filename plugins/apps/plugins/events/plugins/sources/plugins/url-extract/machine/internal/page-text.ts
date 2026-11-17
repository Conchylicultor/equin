import { createHash } from "node:crypto";
import { decodeHtmlText } from "@plugins/infra/plugins/html-decode/core";

// HTML → the page's visible text, and the fingerprint over it.
//
// Pure with respect to the network: everything here takes a `Response` or a
// string, so the whole interesting half of `probe` is unit-testable without a
// fetch.

/**
 * Markup whose text a reader never sees. Dropped WHOLESALE (element + subtree)
 * before any text is read, so a `<script>` body full of JSON-LD, a cookie-banner
 * `<template>`, or the site's `<nav>` link list never reach the model or the
 * fingerprint.
 */
const STRIPPED_SELECTOR = "script, style, noscript, template, nav, footer, svg";

/**
 * Elements that end a line of reading. Without these, `<li>Foo</li><li>Bar</li>`
 * arrives as `FooBar` — one word the model then has to guess apart.
 */
const BLOCK_SELECTOR =
  "p, div, br, li, tr, td, th, dt, dd, section, article, header, aside, main, form, ul, ol, dl, table, blockquote, pre, figcaption, h1, h2, h3, h4, h5, h6";

/**
 * A page's visible text, and whether it is the WHOLE of it.
 *
 * `truncated` exists because a partial read is indistinguishable from a short
 * page downstream: both are well-formed text a model reads happily. Silently
 * handing the model half a listing yields a plausible extraction over material
 * we never saw — and an extraction that comes back empty makes the engine stamp
 * `disappearedAt` on every event the source ever found. So the fact travels with
 * the text and the caller must decide, rather than a `string` that absorbs it.
 */
export interface PageText {
  /** The normalized visible text, bounded by the caller's `maxChars`. */
  text: string;
  /** True when readable content was dropped at the bound — the tail is missing. */
  truncated: boolean;
}

/**
 * Two chained rewriter passes rather than one with a skip flag.
 *
 * A single pass would need `el.onEndTag()` to know when a stripped subtree ends
 * — and Bun's rewriter THROWS `HTMLRewriterError: No end tag.` on a self-closing
 * `<svg/>`, which is ordinary markup. Removing the elements in pass 1 and
 * reading text off the already-cleaned stream in pass 2 has no such edge: the
 * stripped subtrees are simply not in the stream pass 2 sees. (A text handler
 * fires for removed content too, so `chunk.removed` is not a substitute.)
 *
 * Both passes stream — pass 2 transforms pass 1's `Response`, nothing is
 * buffered as HTML.
 *
 * `maxChars` bounds the TEXT rather than the markup, because text is what the
 * model is billed to read; markup length says nothing about it (this page's
 * events sat past 700 KB of inline CMS `<style>`). It is required, not
 * defaulted: an unbounded read is never the right call here, so the bound is not
 * something a caller can forget to think about.
 */
export async function extractVisibleText(
  res: Response,
  maxChars: number,
): Promise<PageText> {
  let raw = "";
  let truncated = false;
  const appendText = (chunk: string): void => {
    if (raw.length < maxChars) {
      raw += chunk;
      return;
    }
    // At the bound. A chunk with a reading in it is content the model will not
    // see; pure whitespace (and the empty chunk Bun emits at a text node's end)
    // normalizes away regardless, so it is not a loss worth parking a source for.
    if (/\S/.test(chunk)) truncated = true;
  };
  const strip = new HTMLRewriter().on(STRIPPED_SELECTOR, {
    element(el) {
      el.remove();
    },
  });
  const read = new HTMLRewriter()
    .on(BLOCK_SELECTOR, {
      element() {
        // A separator, not content: dropping one past the bound loses nothing,
        // so it must not raise `truncated` on a page that ends exactly here.
        if (raw.length < maxChars) raw += "\n";
      },
    })
    .on("*", {
      text(chunk) {
        appendText(chunk.text);
      },
    });

  // `.text()` drives the chained streams to completion; the transformed markup
  // itself is discarded — the handlers above are the only output.
  await read.transform(strip.transform(res)).text();

  return { text: normalizeVisibleText(raw), truncated };
}

/**
 * The canonical form of a page's text — and therefore what the fingerprint is
 * taken over.
 *
 * Entities are decoded EXACTLY ONCE, over the whole accumulated string rather
 * than per chunk: the rewriter splits text on its own buffer boundaries, so a
 * character reference can straddle two chunks and only reassembles here.
 * Skipping this is the documented `d&#x27;` bug — see `infra/html-decode`.
 *
 * Then: NFC (so a page re-served with decomposed accents is the same page),
 * non-breaking / zero-width spaces folded to plain spaces, runs of whitespace
 * collapsed, lines trimmed, blank lines dropped. Every rule exists to make the
 * fingerprint track *content* rather than the reflow churn a CMS emits.
 */
export function normalizeVisibleText(raw: string): string {
  return decodeHtmlText(raw)
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // Zero-width marks carry no reading at all — dropped, not spaced, so a
    // soft-hyphenated word stays one word.
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    // Every other exotic space is just a space.
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The probe's cache key: `sha256(normalized visible text)`.
 *
 * Over the TEXT, never the raw HTML. Raw markup carries a CSRF nonce, an ad
 * slot's cache-buster, and a build hash in every asset URL — all of which move
 * on every single request, so hashing it would report "changed" every tick and
 * pay for an extraction each time. That cache is the entire point of the
 * probe/extract split.
 */
export function fingerprintPageText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
