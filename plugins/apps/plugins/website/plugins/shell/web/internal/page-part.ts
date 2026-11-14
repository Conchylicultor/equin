import type { ComponentType } from "react";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";
import type { WebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { pathShowsPage } from "../../shared/page-path";

/**
 * Something only one page of the site draws (its body, a figure of its own),
 * as its own chunk: the site's code is loaded as one app, so whatever a page
 * imports statically is downloaded and evaluated on every page — `/about`
 * paid for every inner page's scenes. Behind this, a page's code is fetched
 * only where it is shown:
 *
 * - opened on `page` (a cold load of its URL), the chunk starts downloading
 *   the moment the page plugin evaluates and the first paint waits for it
 *   (`lazyComponent`'s `preload: "first-paint"`), so the page still paints
 *   whole;
 * - anywhere else, on first mount (navigating to the page).
 *
 * `load` imports the module holding the component and answers it
 * (`() => import("./components/x-body").then((m) => m.XBody)`).
 */
export function websitePagePart<P extends object>(
  page: WebsitePage,
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  // Outside a page (a barrel imported for introspection) nothing is shown.
  const shown =
    typeof document !== "undefined" &&
    pathShowsPage(currentRoutePath(), page.path);
  return lazyComponent(
    () => load().then((component) => ({ default: component })),
    shown ? { preload: "first-paint" } : undefined,
  );
}
