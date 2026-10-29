/**
 * The title a visit is recorded under: its hostname, or the raw url when it
 * does not parse as a URL (`URL.parse` returns null instead of throwing, so no
 * error is swallowed). The server records it and the browser predicts it, from
 * this one function.
 */
export function visitTitleFor(url: string): string {
  return URL.parse(url)?.hostname ?? url;
}
