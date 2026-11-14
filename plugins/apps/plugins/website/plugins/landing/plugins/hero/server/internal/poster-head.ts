import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import type { WebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";
import { showcasePosterPreload } from "@plugins/apps/plugins/website/plugins/media/server";
import { landingPage } from "@plugins/apps/plugins/website/plugins/shell/core";
import {
  DocumentHead,
  type HeadFragments,
} from "@plugins/shell/plugins/document-head/server";

/**
 * Pure: the poster preload on the landing page, and nothing on every other
 * website page. A head key covers its path and everything under it, and the
 * landing page is the app's base path (`/about`), so each other declared page
 * (`/about/vision`, …) gets a key of its own — the longest match — rather than
 * inheriting a 210 KB download it never shows.
 */
export function renderPosterHead(
  pages: readonly WebsitePage[],
  preload: string,
): HeadFragments {
  const head: HeadFragments = {};
  for (const page of pages) head[page.path] = "";
  head[landingPage.path] = preload;
  return head;
}

/**
 * The hero's film poster is the landing page's largest paint: announced in
 * the head, it downloads alongside the app's code instead of after the first
 * commit draws the `<video>` that asks for it.
 */
export const posterHead = DocumentHead.Fragment({
  id: "website-hero-poster",
  render: () =>
    Promise.resolve(
      renderPosterHead(
        WebsitePages.Page.getContributions(),
        showcasePosterPreload(),
      ),
    ),
  // A constant: the pages and the poster are fixed while the backend runs.
  subscribe: () => () => undefined,
});
