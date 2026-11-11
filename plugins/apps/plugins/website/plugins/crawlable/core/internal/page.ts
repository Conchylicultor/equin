/**
 * The website's address space: every page of the site lives at or under it.
 * The website app's `basePath` is this constant (`shell/core`'s `websiteApp`),
 * so a page path and the app it renders in cannot disagree.
 */
export const WEBSITE_BASE_PATH = "/website";

/**
 * One public page of the website, as data: where it lives, what it is called
 * and what it says in a sentence. The one declaration a page's pane (a
 * `Pane.define` whose route `crawlable:pages-declared` holds to the path), its sitemap entry (`WebsitePages.Page` on the server)
 * and its static snapshot (the manifest below) are all read from — so the three
 * cannot drift.
 */
export interface WebsitePage {
  /** Absolute, `/website` or under it, no params, no trailing slash. */
  readonly path: string;
  /** The page's own name: the pane title, so the tab and document title. */
  readonly title: string;
  /** One sentence about the page: its `<meta name="description">`. */
  readonly description: string;
}

/** Why a page declaration was refused. */
export class WebsitePageError extends Error {
  override name = "WebsitePageError";
}

// A page path is a static address: plain segments only. No `:param` / `*`
// (a sitemap lists addresses, not patterns), no `;keyed` params, no query or
// fragment, no empty segment.
const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;

/**
 * Declare one page of the website — in the page plugin's `core/`, so its
 * `web/` (the pane) and its `server/` (the sitemap entry) both read it:
 *
 * ```ts
 * export const downloadPage = defineWebsitePage({
 *   path: "/website/download",
 *   title: "Download",
 *   description: "One command to install equin, and what to do once it runs.",
 * });
 * ```
 *
 * Throws a `WebsitePageError` at module eval on a path that is not a static
 * address under `/website`, or an empty title or description.
 */
export function defineWebsitePage(page: WebsitePage): WebsitePage {
  const { path, title, description } = page;
  if (path !== WEBSITE_BASE_PATH) {
    if (!path.startsWith(`${WEBSITE_BASE_PATH}/`)) {
      throw new WebsitePageError(
        `Website page "${path}": a page lives at ${WEBSITE_BASE_PATH} or under it ` +
          `(${WEBSITE_BASE_PATH}/<segment>…).`,
      );
    }
    const rest = path.slice(WEBSITE_BASE_PATH.length + 1);
    for (const segment of rest.split("/")) {
      if (!SEGMENT.test(segment)) {
        throw new WebsitePageError(
          `Website page "${path}": segment "${segment}" is not a static path segment ` +
            `(lowercase letters, digits, ".", "_", "~", "-"; no params, no trailing slash).`,
        );
      }
    }
  }
  if (title.trim() === "") {
    throw new WebsitePageError(`Website page "${path}": empty title.`);
  }
  if (description.trim() === "") {
    throw new WebsitePageError(`Website page "${path}": empty description.`);
  }
  return Object.freeze({ path, title, description });
}

/** The pane identity a page's path gives its website pane. */
export interface WebsitePaneIdentity {
  /** The route id: `website-<segment>` (`/` as `-`), `website-landing` for the index. */
  readonly id: string;
  /** The route segment: the path relative to `/website`, `""` for `/website` itself. */
  readonly segment: string;
  /** Whether the pane is the website app's index pane (the landing page). */
  readonly appIndex: boolean;
}

/**
 * The route a page's pane must declare, derived from the page's path. Each
 * pane spells it as literals (`pane:identity-manifest` reads pane identity
 * from source, so a route built from data would be unreadable there);
 * `crawlable:pages-declared` holds the literals to this derivation.
 */
export function websitePaneIdentity(path: string): WebsitePaneIdentity {
  const segment =
    path === WEBSITE_BASE_PATH ? "" : path.slice(WEBSITE_BASE_PATH.length + 1);
  return {
    id: `website-${segment === "" ? "landing" : segment.replaceAll("/", "-")}`,
    segment,
    appIndex: segment === "",
  };
}
