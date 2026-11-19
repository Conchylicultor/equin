import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";

/** How many paths one read of the page list offers by default: the top of it. */
export const SITE_PAGES_WINDOW = 50;

/**
 * The paths a site's visits hit — the values the Sessions list's `pages`
 * column takes, so its Pages filter offers them — read from this computer's
 * copy of the site's analytics (collect's own SQL), most visited first, then
 * by path. A window, never the whole set: a site's paths grow with its
 * traffic (one per id a visitor opens in the demo), so a reader takes the top
 * of the list or searches it (`where: path contains …`, run on the copy).
 * Every question names its site (`clause("deploymentId", "eq", id)`), as the
 * sessions list's do. Pushed as the sessions list is: every page a pull
 * applies to the copy re-reads it.
 */
export const deploymentPages = liveCollection("deploy-analytics.pages", {
  fields: {
    /** Which site — the scope every read names. */
    deploymentId: textField({ label: "Site" }),
    path: textField({ label: "Page" }),
    visits: intField({ label: "Visits" }),
  },
  carry: {
    fields: {
      /** `<deploymentId>/<path>` (`sitePageKey`): a path is unique within one site's copy only. */
      key: textField(),
    },
  },
  id: "key",
  sortable: ["visits"],
  default: { orderBy: [["visits", "desc"]], limit: SITE_PAGES_WINDOW },
  maxLimit: 200,
});

/** One row of {@link deploymentPages}. */
export type SitePage =
  typeof deploymentPages extends LiveRowsCollection<infer R> ? R : never;

/** The key of a site's path: unique across every site's copy. */
export function sitePageKey(deploymentId: string, path: string): string {
  return `${deploymentId}/${path}`;
}

/**
 * A key's two parts — a deployment id holds no `/` and a path starts with
 * one, so the key splits at its first `/`. Throws on a key
 * {@link sitePageKey} never spells.
 */
export function parseSitePageKey(key: string): {
  deploymentId: string;
  path: string;
} {
  const slash = key.indexOf("/");
  if (slash <= 0)
    throw new Error(`deploy-analytics.pages: malformed key ${key}`);
  return { deploymentId: key.slice(0, slash), path: key.slice(slash) };
}

/** The `visits` part of a row's `$key`: fixed-width digits, so code-point order is numeric order. */
export const visitsKeyText = (visits: number): string =>
  String(visits).padStart(12, "0");
