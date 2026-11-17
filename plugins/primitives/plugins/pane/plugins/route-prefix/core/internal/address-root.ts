/**
 * The address root: the base path of the app a composition serves at `/`
 * (a composition whose `homeAtRoot` is set — the public website, `/about`,
 * served at `equin.ai/`). Inside the app every path keeps its base path (a
 * ROUTE path, `/about/vision`); only the address — what the browser shows,
 * what a link or a sitemap hands out — drops it (an ADDRESS path, `/vision`).
 *
 * Pure, so every side that crosses the boundary spells it the same way: the
 * browser's URL reads and writes (`route-prefix/web`), the snapshot's links,
 * the sitemap (crawlable's server) and the public-site links (website/shell).
 * The gateway mirrors it in Go (`gateway/snapshot.go`, `addressToRoute`).
 *
 * `root` null is a composition with no address root: both directions are the
 * identity.
 */

/** Why a path cannot cross the address boundary. */
export class AddressRootError extends Error {
  override name = "AddressRootError";
}

function assertRoot(root: string): void {
  if (!/^\/[^/?#;]+(\/[^/?#;]+)*$/.test(root)) {
    throw new AddressRootError(
      `address root "${root}" is not an app base path (absolute, not "/", no trailing slash)`,
    );
  }
}

/**
 * Whether a route path is the root app's: its base path, under it, or its
 * landing pane's keyed suffix on the base path itself (`/about;k=v`).
 */
export function isUnderAddressRoot(routePath: string, root: string): boolean {
  return (
    routePath === root ||
    routePath.startsWith(root + "/") ||
    routePath.startsWith(root + ";")
  );
}

/**
 * The address a route path is shown at: `/about/vision` → `/vision`,
 * `/about` → `/`, `/about;k=v` → `/;k=v`. Throws an {@link AddressRootError}
 * for a route path outside the root app — a composition served at its home
 * app's root has no address for another app's page, and a silent identity
 * would hand out a link that opens the wrong page.
 */
export function addressPathOf(routePath: string, root: string | null): string {
  if (root === null) return routePath;
  assertRoot(root);
  if (!isUnderAddressRoot(routePath, root)) {
    throw new AddressRootError(
      `route path "${routePath}" is outside the address root "${root}": this composition serves only its home app, at /`,
    );
  }
  const rest = routePath.slice(root.length);
  return rest.startsWith("/") ? rest : "/" + rest;
}

/**
 * The route path an address names: `/vision` → `/about/vision`, `/` →
 * `/about`, `/;k=v` → `/about;k=v`. Every address has one (the root app owns
 * the whole address space), so this never throws for a path.
 */
export function routePathOf(addressPath: string, root: string | null): string {
  if (root === null) return addressPath;
  assertRoot(root);
  if (!addressPath.startsWith("/")) {
    throw new AddressRootError(`address "${addressPath}" is not absolute`);
  }
  if (addressPath === "/") return root;
  if (addressPath.startsWith("/;")) return root + addressPath.slice(1);
  return root + addressPath;
}

/**
 * {@link addressPathOf} over an in-app URL that may carry a query and a hash
 * (`/about/vision?x=1#h` → `/vision?x=1#h`).
 */
export function addressUrlOf(url: string, root: string | null): string {
  if (root === null) return url;
  const end = url.search(/[?#]/);
  const path = end < 0 ? url : url.slice(0, end);
  return addressPathOf(path, root) + (end < 0 ? "" : url.slice(end));
}
