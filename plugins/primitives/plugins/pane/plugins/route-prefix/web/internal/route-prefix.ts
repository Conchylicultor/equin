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
 */

// eslint-disable-next-line install-sink/no-adhoc-install-sink -- not filled late: apps-core installs it synchronously in the apps root's FIRST render (from the eager Apps.App entries, fixed for the page), ahead of every routing read in that tree; its reader is `currentRoutePath`, a plain function of the address bar that has nothing to subscribe with.
let known: readonly string[] = [];
// eslint-disable-next-line install-sink/no-adhoc-install-sink -- not filled late: the tabs layer writes it synchronously (in render and in its mode switch) before any URL is written, and it is read only at write time — a history commit, a link opened in a new tab — never during render.
let active: string | undefined;

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

/** Split a canonical pathname into its route prefix and the app route path. */
export function splitRoutePrefix(pathname: string): SplitRoutePath {
  for (const prefix of known) {
    if (pathname === prefix) return { prefix, path: "/" };
    if (pathname.startsWith(prefix + "/")) {
      return { prefix, path: pathname.slice(prefix.length) };
    }
  }
  return { prefix: undefined, path: pathname };
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
 * shows it under the active prefix. Anything else — an absolute URL, a path
 * already carrying a known prefix, no active prefix — is returned unchanged.
 */
export function withActiveRoutePrefix(url: string): string {
  if (active === undefined || !url.startsWith("/") || url.startsWith("//")) {
    return url;
  }
  const end = url.search(/[?#]/);
  const path = end < 0 ? url : url.slice(0, end);
  if (splitRoutePrefix(path).prefix !== undefined) return url;
  return path === "/" ? active + url.slice(1) : active + url;
}

/** Drop the installed state between tests. */
export function resetRoutePrefixForTests(): void {
  known = [];
  active = undefined;
}
