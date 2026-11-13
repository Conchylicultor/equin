import { resolveSpecifier } from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";

/**
 * The modules `symbol` / `brand` / `seti` can be imported from, by repo path:
 * the core barrel, and the file defining them — which the icons plugin's own
 * files reach by a relative path (`./icon-ref`, `../../core`).
 */
const ICON_REF_MODULES = [
  "plugins/ui/plugins/icons/core/index.ts",
  "plugins/ui/plugins/icons/core/icon-ref.ts",
] as const;

/** Whether `path` (repo-relative, or absolute under the repo) is one of {@link ICON_REF_MODULES}. */
const isIconRefFile = (path: string): boolean =>
  ICON_REF_MODULES.some((m) => path === m || path.endsWith(`/${m}`));

/**
 * Does the import `specifier`, written in `fromFile` (repo-relative or
 * absolute), resolve to the module that exports the icon constructors?
 *
 * The one answer to "is this the icons `symbol`" for every reader that scans
 * source for icon names — the manifest scan and the icons lint rules — so a
 * file reaching the constructors by any spelling (the barrel alias, or a
 * relative path from inside the plugin) is never invisible to one of them.
 * Resolved by the module graph's own resolver (`plugin-records/specifier`)
 * against the two files it asks about: a lint rule judges one file, with no
 * file set to resolve against.
 */
export function isIconRefModule(fromFile: string, specifier: string): boolean {
  return resolveSpecifier(fromFile, specifier, isIconRefFile) !== null;
}
