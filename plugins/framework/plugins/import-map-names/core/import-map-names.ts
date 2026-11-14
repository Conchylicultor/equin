// A browser host is served through the import map as `@browser-host/<pluginPath>`
// (see web-artifacts' `core/internal/browser-hosts.ts`): a bare specifier external to every
// artifact build and never an npm package, so neither the vendor set nor the
// barrel closure ever reads it.

export const BROWSER_HOST_SPECIFIER_PREFIX = "@browser-host/";

export function isBrowserHostSpecifier(id: string): boolean {
  return id.startsWith(BROWSER_HOST_SPECIFIER_PREFIX);
}

/**
 * A browser host's worker entry, mapped by the page's import map to the entry
 * artifact inside the dist's worker tree (web-artifacts' `core/internal/worker-link.ts`). `host.js`
 * starts the worker from `import.meta.resolve` of it, so the host module's bytes
 * never name the tree, whose name changes with the worker's code.
 */
export const BROWSER_HOST_WORKER_SPECIFIER_PREFIX = "@browser-host-worker/";

/**
 * A browser host's starting snapshot, as its worker imports it
 * (`@browser-host-snapshot/<pluginPath>`, web-artifacts' `core/internal/host-snapshots.ts`): a
 * bare specifier external to every artifact build, linked by the worker tree
 * to the snapshot the build took for that host.
 */
export const BROWSER_HOST_SNAPSHOT_SPECIFIER_PREFIX = "@browser-host-snapshot/";

export function isBrowserHostSnapshotSpecifier(id: string): boolean {
  return id.startsWith(BROWSER_HOST_SNAPSHOT_SPECIFIER_PREFIX);
}

/**
 * Whether `id` is in a namespace only a page's import map answers. Bun never
 * resolves one (no tsconfig path, no package of that name), so code a server
 * may hold that names one — a lazy `import("@browser-host/…")` in a `core/`
 * module the page calls and the server never does — loads nothing on the
 * server. A closure walk (`packages/source-digest`) counts such an edge by
 * its name instead of refusing it as unresolved.
 */
export function isImportMapOnlySpecifier(id: string): boolean {
  return (
    id.startsWith(BROWSER_HOST_SPECIFIER_PREFIX) ||
    id.startsWith(BROWSER_HOST_WORKER_SPECIFIER_PREFIX) ||
    id.startsWith(BROWSER_HOST_SNAPSHOT_SPECIFIER_PREFIX)
  );
}

/**
 * Plugin barrels a page script OUTSIDE the app bundle imports by specifier — a
 * head script the server splices before the app boots — sharing module state
 * with the app. Every other plugin module reaches the page bundled into the
 * build's route chunks and is named by URL, so the import map answers these
 * specifiers only: the build makes each its own link entry, one instance with
 * the app's (web-artifacts' `core/internal/link.ts`), and maps it.
 *
 * A closed list both halves read — the build, and the head script that spells
 * its import from it (so the two cannot disagree).
 */
export const PAGE_SCRIPT_MODULES = {
  /** The /demo page's head start of its browser host (`apps/demo/shell`'s prestart head). */
  demoPrestart:
    "@plugins/framework/plugins/browser-server/plugins/demo/plugins/prestart/web",
} as const;
