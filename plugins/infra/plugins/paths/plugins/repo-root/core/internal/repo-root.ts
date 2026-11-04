import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * This module's own directory, relative to the checkout root. A path mention
 * of this plugin, so `./equin plugin move` rewrites it with the plugin (and
 * `relocate:moved-plugins-unnamed` fails on a stale one); a value that does
 * not end this module's real location throws at load (`repoRootOf`).
 */
const OWN_DIR = "plugins/infra/plugins/paths/plugins/repo-root/core/internal";

/**
 * Where every module of a `bun build --compile` binary reports itself: the
 * bundle flattens the tree, so no module there has a checkout around it.
 */
const COMPILED_ROOT = "/$bunfs/root";

/**
 * The checkout root, given the directory of the module at `ownDir` (its
 * repo-relative directory). Strips the suffix rather than climbing a counted
 * number of `../`, so the answer cannot drift from where the module really is.
 * A compiled binary has no checkout: its virtual root is the answer (a read
 * under it finds nothing, as a read of an un-shipped repo file must).
 */
export function repoRootOf(moduleDir: string, ownDir: string): string {
  const suffix = `/${ownDir}`;
  if (moduleDir.endsWith(suffix)) return moduleDir.slice(0, -suffix.length);
  if (moduleDir === COMPILED_ROOT || moduleDir.startsWith(`${COMPILED_ROOT}/`))
    return COMPILED_ROOT;
  throw new Error(
    `repo-root: this module sits at ${moduleDir}, which does not end with its declared ${ownDir} — the plugin moved and OWN_DIR was not rewritten with it`,
  );
}

/**
 * The checkout this code runs from (main's or a worktree's). The one place a
 * file gets the repo root: join a repo-relative path onto it — never count
 * `../` from your own location (`repo-root/no-depth-counted-path`), which
 * encodes your depth and silently re-aims when your plugin moves.
 *
 * Read from `import.meta.url` (not `import.meta.dir`, Bun's own), so a module
 * evaluated by vitest or eslint under Node answers the same.
 */
export const REPO_ROOT: AppPath = asAppPath(
  repoRootOf(
    decodeURIComponent(new URL(".", import.meta.url).pathname).replace(
      /\/$/,
      "",
    ),
    OWN_DIR,
  ),
);
