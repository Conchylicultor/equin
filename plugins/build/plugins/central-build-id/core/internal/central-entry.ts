/**
 * Central's entry, relative to a checkout root — the module whose closure IS
 * central's code (its registry's barrels are literal imports of it, so the
 * closure walk reaches every central plugin). Central's code build is the
 * source digest of this module's closure: central digests the entry it runs
 * (`Bun.main`, which must end with this path), `./equin build` digests this
 * path in the checkout it builds, and a tab carries the build's answer — so a
 * central value the tab's schema rejects is judged by build
 * (`network/live/resource-protocol`'s `contractVerdict`).
 */
export const CENTRAL_ENTRY =
  "plugins/framework/plugins/central-core/bin/index.ts";
