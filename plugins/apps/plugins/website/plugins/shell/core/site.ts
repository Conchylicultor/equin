import {
  MAIN_WORKTREE_NAME,
  namespaceHost,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";

/**
 * Where the code behind this site lives. A site-level fact, not a component's:
 * the footer signs off with it on every page, and one address declared twice is
 * one address that drifts.
 */
const REPO = "Conchylicultor/singularity";
export const SOURCE_URL = `https://github.com/${REPO}`;

/**
 * The one address the site publishes. Every reach-out on the site goes here —
 * the contact band's two cards and the footer's email link — so it is declared
 * beside the source link rather than inside either of them.
 */
export const CONTACT_EMAIL = "hello@equin.ai";
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/**
 * Where a visitor files a bug report, a feature request or a question: a new
 * issue on the source repository. Derived from `SOURCE_URL` so the two cannot
 * point at different repositories.
 */
export const ISSUES_URL = `${SOURCE_URL}/issues/new`;

/**
 * The one command that installs equin on a Mac: the repository's own
 * `install.sh`, piped from its `main` branch. Derived from the same repository
 * as `SOURCE_URL`, so the page cannot offer one repository's installer beside
 * another's source.
 */
export const INSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`;

/**
 * Where an installed equin answers: the main namespace behind the local gateway.
 * Every copy lives at the same address, so the site can name it.
 */
export const LOCAL_APP_HOST = namespaceHost(MAIN_WORKTREE_NAME);
export const LOCAL_APP_URL = namespaceUrl(MAIN_WORKTREE_NAME);
