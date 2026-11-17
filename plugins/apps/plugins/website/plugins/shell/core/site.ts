import {
  SOURCE_REPO,
  SOURCE_REPO_URL,
} from "@plugins/framework/plugins/product-name/core";
import { WEBSITE_BASE_PATH } from "@plugins/apps/plugins/website/plugins/crawlable/core";
import {
  addressPathOf,
  routePathOf,
} from "@plugins/primitives/plugins/pane/plugins/route-prefix/core";
import {
  GATEWAY_PORT,
  MAIN_WORKTREE_NAME,
  namespaceFromHost,
  namespaceHost,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";

/**
 * The one address the site publishes. Every reach-out on the site goes here —
 * the contact band's two cards and the footer's email link — so it is declared
 * in one place rather than inside either of them.
 */
export const CONTACT_EMAIL = "hello@equin.ai";
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/**
 * Where a visitor files a bug report, a feature request or a question: a new
 * issue on the source repository. Derived from `SOURCE_REPO_URL` so the two cannot
 * point at different repositories.
 */
export const ISSUES_URL = `${SOURCE_REPO_URL}/issues/new`;

/**
 * The one command that installs equin on a Mac: the repository's own
 * `install.sh`, piped from its `main` branch. Derived from the same repository
 * as `SOURCE_REPO_URL`, so the page cannot offer one repository's installer beside
 * another's source.
 */
export const INSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${SOURCE_REPO}/main/install.sh | bash`;

/**
 * Where an installed equin answers: the main namespace behind the local gateway.
 * Every copy lives at the same address, so the site can name it.
 */
export const LOCAL_APP_HOST = namespaceHost(MAIN_WORKTREE_NAME);
export const LOCAL_APP_URL = namespaceUrl(MAIN_WORKTREE_NAME);

/**
 * Where the site is published: the `website` composition, which serves the
 * website app at `/` (its `homeAtRoot`) — `equin.ai/vision` is the local
 * app's `/about/vision`. A page moves between the two by swapping the origin
 * and putting back, or dropping, `WEBSITE_BASE_PATH` (route-prefix's address
 * root, `PUBLIC_SITE_ROOT`).
 */
export const PUBLIC_SITE_ORIGIN = "https://equin.ai";

/** The base path the published site drops from its addresses. */
const PUBLIC_SITE_ROOT = WEBSITE_BASE_PATH;

/**
 * A website page (`/about/guide`, query and hash allowed) as published:
 * `https://equin.ai/guide`.
 */
export function publicSitePageUrl(path: string): string {
  const end = path.search(/[?#]/);
  const pathname = end < 0 ? path : path.slice(0, end);
  return `${PUBLIC_SITE_ORIGIN}${addressPathOf(pathname, PUBLIC_SITE_ROOT)}${end < 0 ? "" : path.slice(end)}`;
}

/** Whether `url` is a page of the published site. */
export function isPublicSiteUrl(url: URL): boolean {
  return url.origin === PUBLIC_SITE_ORIGIN;
}

/** Whether `url` is a page of the website app (under its base path), on any origin. */
function isSitePath(url: URL): boolean {
  return (
    url.pathname === WEBSITE_BASE_PATH ||
    url.pathname.startsWith(`${WEBSITE_BASE_PATH}/`)
  );
}

/**
 * Whether `url` is any page of a local equin instance: a namespace host of
 * this machine's gateway (main or a worktree), whatever the app.
 */
export function isLocalAppUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.port === String(GATEWAY_PORT) &&
    namespaceFromHost(url.host) !== null
  );
}

/** A published page, on the local instance: the base path put back. */
export function localSiteUrl(url: URL): string {
  if (!isPublicSiteUrl(url))
    throw new Error(`${url.href} is not a page of ${PUBLIC_SITE_ORIGIN}`);
  return `${new URL(LOCAL_APP_URL).origin}${routePathOf(url.pathname, PUBLIC_SITE_ROOT)}${url.search}${url.hash}`;
}

/**
 * A local equin page, on equin.ai: a website page at its published address
 * (the base path dropped), any other app's page (which equin.ai does not
 * publish) at the site's home.
 */
export function publicSiteUrl(url: URL): string {
  if (!isLocalAppUrl(url))
    throw new Error(`${url.href} is not a page of a local equin instance`);
  return isSitePath(url)
    ? `${PUBLIC_SITE_ORIGIN}${addressPathOf(url.pathname, PUBLIC_SITE_ROOT)}${url.search}${url.hash}`
    : `${PUBLIC_SITE_ORIGIN}/`;
}
