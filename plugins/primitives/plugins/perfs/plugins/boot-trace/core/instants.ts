// Ids of the boot instants that end the "page request → first screen" window,
// stamped by their owners and read by the cold-start benchmark (through the
// User Timing mirror). One place, so stamper and reader name the same instant.

/**
 * The first React commit after the boot snapshot is hydrated (infra/boot-snapshot):
 * chrome and eager panes reading real data. Deferred-tier route content may still
 * be loading.
 */
export const FIRST_DATA_COMMIT_ID = "first-data-commit";

/**
 * The first React commit with the active app's content loaded (web-core's boot
 * sequence): the commit that appends the active app's priority deferred batch,
 * or the first-data commit itself when that app has no deferred content.
 */
export const ROUTE_CONTENT_COMMIT_ID = "route-content-commit";
