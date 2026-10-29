// Where the product's code is published. Spelled once here for code; files that
// cannot import it (install.sh, docs/setup.md, CITATION.cff, the clean-install
// scripts) write the same URL out. The old repository name is never written
// again — `product-name:legacy-id` flags it — and GitHub redirects it only while
// no repository is created again under that name.

/** The GitHub repository the product is published from (`owner/name`). */
export const SOURCE_REPO = "Conchylicultor/equin";

/** The repository's web and clone URL. */
export const SOURCE_REPO_URL = `https://github.com/${SOURCE_REPO}`;
