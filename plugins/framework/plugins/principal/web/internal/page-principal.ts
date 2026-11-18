/**
 * Who the page's own server takes this page for — the principal its boot
 * snapshot was served to (`network/live/boot-snapshot` records it before first
 * paint, from the snapshot's `caller`). `owner` on the owner's own instance;
 * `visitor` on a deployed site's public pages, where every owner-only route
 * answers 403 — so a page asks before sending a write it would be refused
 * (`useWriteAvailability`, `infra/endpoints`) instead of finding out from an
 * unhandled rejection.
 *
 * Fixed for the page's life: one page boots once, and its principal is the
 * edge's verdict on its origin, which a page cannot change.
 */
export type PagePrincipal = "owner" | "visitor";

/**
 * `unknown`: no boot snapshot recorded one — a page that does not boot through
 * it (a test, a static render). The page's server stays the authority there:
 * its gate still refuses what it does not admit.
 */
let recorded: PagePrincipal | "unknown" = "unknown";

/** Records the page's principal — once, by the page's boot. */
export function recordPagePrincipal(principal: PagePrincipal): void {
  if (recorded !== "unknown" && recorded !== principal) {
    throw new Error(
      `page principal: the page booted as "${recorded}" and is now told "${principal}" — a page's principal never changes`,
    );
  }
  recorded = principal;
}

/** Who the page's own server takes this page for, as its boot recorded it. */
export function pagePrincipal(): PagePrincipal | "unknown" {
  return recorded;
}
