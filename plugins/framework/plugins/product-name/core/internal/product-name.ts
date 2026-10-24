// The product's own name — what a person or an agent reads in a title, a
// message, a doc or a tool description.
//
// It is always lowercase, even at the start of a sentence or in a title: the
// website's convention, kept everywhere so there is one spelling to copy.

/** The product's name: `equin`. */
export const PRODUCT_NAME = "equin";

/**
 * Names the product went by before. Internal identifiers built from them (the
 * `singularity` namespace and database, `~/.singularity/`, `SINGULARITY_*`) are
 * a separate decision; the capitalised product name is never written again —
 * `product-name:legacy` flags it.
 */
export const LEGACY_PRODUCT_NAMES: readonly string[] = ["Singularity"];
