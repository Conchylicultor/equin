import { parseUrl } from "@plugins/packages/plugins/floor-compat/core";

/**
 * The title a visit is recorded under: its hostname, or the raw url when it
 * does not parse as a URL (`parseUrl` answers null for exactly what the URL
 * constructor rejects, so no other error is swallowed). The server records it
 * and the browser predicts it, from this one function.
 */
export function visitTitleFor(url: string): string {
  return parseUrl(url)?.hostname ?? url;
}
