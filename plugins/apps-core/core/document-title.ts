import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * The browser document title of a page: `<Entity> — <App> — equin`, each part
 * once and the unknown ones left out — an app named after the product (the
 * website's `equin`) says it once, `Download — equin`.
 *
 * The one spelling of it: the live app's `DocumentTitleSync` (apps-core
 * layout) writes it into `document.title`, and the crawlable website's static
 * snapshot (`apps/website/crawlable`) writes it into each page's manifest
 * entry, so a robot reads the title a visitor's tab shows.
 */
export function documentTitle(parts: {
  /** The focused tab's content title (its title-owner pane's), when known. */
  entity: string | undefined;
  /** The focused app's display name (`AppRef.name`), when known. */
  app: string | undefined;
}): string {
  return [...new Set([parts.entity, parts.app, PRODUCT_NAME])]
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" — ");
}
