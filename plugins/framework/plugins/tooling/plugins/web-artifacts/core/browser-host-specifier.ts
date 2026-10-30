// A browser host is served through the import map as `@browser-host/<pluginPath>`
// (see `internal/browser-hosts.ts`): a bare specifier external to every
// artifact build and never an npm package, so neither the vendor set nor the
// barrel closure ever reads it.

export const BROWSER_HOST_SPECIFIER_PREFIX = "@browser-host/";

export function isBrowserHostSpecifier(id: string): boolean {
  return id.startsWith(BROWSER_HOST_SPECIFIER_PREFIX);
}

/**
 * A browser host's worker entry, mapped by the page's import map to the entry
 * artifact inside the dist's worker tree (`internal/worker-link.ts`). `host.js`
 * starts the worker from `import.meta.resolve` of it, so the host module's bytes
 * never name the tree, whose name changes with the worker's code.
 */
export const BROWSER_HOST_WORKER_SPECIFIER_PREFIX = "@browser-host-worker/";
