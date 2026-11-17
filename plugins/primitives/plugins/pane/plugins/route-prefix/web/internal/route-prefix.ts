import { addressUrlOf, routePathOf } from "../../core";

/**
 * Route prefixes: a leading path segment of the address bar that belongs to no
 * app's route but to the WAY the page shows them — the desktop's `/desktop`,
 * written in front of the focused window's own URL while the surface is in
 * desktop mode (`/desktop/agents/c/42`). Bare, the prefix is that mode with
 * nothing open.
 *
 * Two page-global facts, both installed from above (apps-core knows which
 * surface modes own a prefix; the tabs layer knows the current mode):
 *
 *  - the KNOWN prefixes — every read strips the one the URL carries
 *    (`splitRoutePrefix`), so routing below never sees it;
 *  - the ACTIVE prefix — the one the current mode writes, put back by every
 *    URL writer and in front of every in-app path opened in a new browser tab
 *    (`withActiveRoutePrefix`), so the new tab comes up the same way.
 *
 * And a third, fixed for the page: the ADDRESS ROOT (`setAddressRoot`,
 * installed by apps-core from the composition's `homeAtRoot`) — the base path
 * of the app a released composition serves at `/` (the public site's
 * `/about`). Every read puts it back in front of the address
 * (`/vision` → `/about/vision`), every write drops it, so routing never sees
 * the difference (`core/internal/address-root.ts`).
 */

// eslint-disable-next-line install-sink/no-adhoc-install-sink -- not filled late: apps-core installs it synchronously in the apps root's FIRST render (from the eager Apps.App entries, fixed for the page), ahead of every routing read in that tree; its reader is `currentRoutePath`, a plain function of the address bar that has nothing to subscribe with.
let known: readonly string[] = [];
// eslint-disable-next-line install-sink/no-adhoc-install-sink -- not filled late: the tabs layer writes it synchronously (in render and in its mode switch) before any URL is written, and it is read only at write time — a history commit, a link opened in a new tab — never during render.
let active: string | undefined;
// eslint-disable-next-line install-sink/no-adhoc-install-sink -- not filled late: apps-core installs it with the known prefixes, synchronously in the apps root's FIRST render (from the composition the page booted, fixed for the page), ahead of every routing read; read by plain functions of the address bar.
let addressRoot: string | null = null;

/** A prefix as written: one leading `/`, no trailing `/`, not the root. */
function canonical(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  if (trimmed === "" || !trimmed.startsWith("/")) {
    throw new Error(`route-prefix: "${prefix}" is not a path prefix`);
  }
  return trimmed;
}

/**
 * Install the known prefixes (each surface-mode app's base path). Idempotent;
 * longest first, so a nested prefix wins the way a nested app base path does.
 */
export function setRoutePrefixes(prefixes: readonly string[]): void {
  known = [...new Set(prefixes.map(canonical))].sort(
    (a, b) => b.length - a.length,
  );
}

export interface SplitRoutePath {
  /** The known prefix `pathname` starts with, if any. */
  prefix: string | undefined;
  /** `pathname` without it — the plain app route path (`/` for a bare prefix). */
  path: string;
}

/**
 * Install the address root: the base path of the app this composition serves
 * at `/` (`null`: none — every address is its route path). Idempotent.
 */
export function setAddressRoot(root: string | null): void {
  addressRoot = root === null ? null : canonical(root);
}

/** The installed address root (`null`: none). */
export function peekAddressRoot(): string | null {
  return addressRoot;
}

/**
 * Split a canonical ADDRESS pathname into its route prefix and the app route
 * path — the address root put back in front (`/vision` → `/about/vision`).
 */
export function splitRoutePrefix(pathname: string): SplitRoutePath {
  for (const prefix of known) {
    if (pathname === prefix)
      return { prefix, path: routePathOf("/", addressRoot) };
    if (pathname.startsWith(prefix + "/")) {
      return {
        prefix,
        path: routePathOf(pathname.slice(prefix.length), addressRoot),
      };
    }
  }
  return { prefix: undefined, path: routePathOf(pathname, addressRoot) };
}

/** Set the prefix the current surface mode writes (`undefined`: none). */
export function setActiveRoutePrefix(prefix: string | undefined): void {
  active = prefix === undefined ? undefined : canonical(prefix);
}

/** The prefix the current surface mode writes, if any. */
export function activeRoutePrefix(): string | undefined {
  return active;
}

/**
 * An in-app URL (`/agents/c/1`, query and hash allowed) as the address bar
 * shows it: the address root dropped (`/about/vision` → `/vision`), under the
 * active prefix. An absolute URL is returned unchanged; so is a path already
 * carrying a known prefix (it is an address already). A route path outside
 * the address root throws (`addressPathOf`).
 */
export function withActiveRoutePrefix(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const end = url.search(/[?#]/);
  const path = end < 0 ? url : url.slice(0, end);
  if (known.some((p) => path === p || path.startsWith(p + "/"))) return url;
  const address = addressUrlOf(url, addressRoot);
  if (active === undefined) return address;
  return address.startsWith("/?") || address.startsWith("/#") || address === "/"
    ? active + address.slice(1)
    : active + address;
}

/** Drop the installed state between tests. */
export function resetRoutePrefixForTests(): void {
  known = [];
  active = undefined;
  addressRoot = null;
}
