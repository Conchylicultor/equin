import { canParseUrl } from "@plugins/packages/plugins/floor-compat/core";
/**
 * `raw` if it is an absolute `http(s)` URL, else `null`.
 *
 * The ONE gate every URL in this app passes before it reaches the DOM, in any
 * role that has one: the gallery poster's `<img src>`, the link an event row
 * opens, and the page a configured source stands for. Both ends are untrusted —
 * an event row is extracted from a scraped page by a model, and a source's own
 * page is whatever the user typed into a free-text field — so anything that
 * isn't an ordinary web address (a relative path, a `data:` blob, a
 * `javascript:` string) is not a destination and not a src.
 *
 * It lives in `events-core` rather than beside one of its callers because it is
 * a property of the app's data, not of a surface: a second copy in a second
 * plugin is a security guard with two spellings to keep in step.
 *
 * `null` is the whole point at every call site: the gallery cover accessor
 * returns it verbatim, so an event without a usable poster gets NO cover region
 * (the plain text card) rather than an empty frame or a broken-image glyph; a
 * row's open handler, its link chip, and a source's "open page" action simply
 * offer nothing.
 */
export function externalUrl(raw: string | null): string | null {
  if (raw === null || !canParseUrl(raw)) return null;
  const { protocol } = new URL(raw);
  return protocol === "http:" || protocol === "https:" ? raw : null;
}
