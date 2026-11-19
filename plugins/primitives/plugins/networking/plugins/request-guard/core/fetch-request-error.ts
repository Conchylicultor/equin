import { canParseUrl } from "@plugins/packages/plugins/floor-compat/core";
/**
 * A page `fetch` that rejected — no HTTP answer came back (the network dropped,
 * the request was blocked by an extension or CORS) or the browser refused to
 * send it — named by the request it was for.
 *
 * The browser's own error is a bare `TypeError` ("Failed to fetch", Firefox's
 * "NetworkError when attempting to fetch resource.", Safari's "Load failed")
 * naming neither the URL nor, in Firefox, a single stack frame. One left
 * unhandled reached Reports as exactly that line and nobody could place it
 * (report-1794609421-fk1a49, 50 occurrences on equin.ai). The request guard sees
 * every page fetch — the guarded global `fetch` any library calls and
 * `nativeFetch`, the page transport's — so it raises this one instead: the
 * method and URL in the message, the browser's words kept as
 * {@link browserMessage} (and as `cause`), and the stack of the code that
 * CALLED fetch, captured when it was called.
 *
 * It IS a `TypeError`, so a caller telling "no answer" from a non-2xx with
 * `err instanceof TypeError` keeps working unchanged.
 */
export class FetchRequestError extends TypeError {
  override readonly name = "FetchRequestError";
  constructor(
    readonly method: string,
    /** The request, as named in the message: path and query when same-origin, else the whole URL — capped. */
    readonly url: string,
    /** The browser's own message ("Failed to fetch", …). */
    readonly browserMessage: string,
    cause: TypeError,
  ) {
    super(`${method} ${url}: ${browserMessage}`, { cause });
  }
}

/** Longest URL a {@link FetchRequestError} message carries (a glyph batch's names can run long). */
const MAX_NAMED_URL = 300;

/**
 * How a request's URL is named: same-origin as its path and query (the origin
 * is the page's), another origin in full; resolved against `base` (none off a
 * page: the URL as given); capped.
 */
export function nameRequestUrl(raw: string, base: string | undefined): string {
  let named = raw;
  if (base !== undefined && canParseUrl(raw, base)) {
    const url = new URL(raw, base);
    named =
      url.origin === new URL(base).origin
        ? url.pathname + url.search
        : url.origin + url.pathname + url.search;
  }
  return named.length > MAX_NAMED_URL
    ? `${named.slice(0, MAX_NAMED_URL)}… (${named.length} chars)`
    : named;
}
