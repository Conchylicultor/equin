import {
  asAppPath,
  joinAppPath,
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
 * A self-contained bundle's directory name ends with this
 * (`infra/spawn/daemon/bundle`: a detached daemon's entry bundled into one
 * directory, run without the checkout it was built from). Every module there
 * reports a location inside it — the entry at the bundle's root or a script
 * at its repo-relative path below — so the bundle directory is that code's
 * root: the scripts it runs by path (`scriptPath`) and the sealed dependencies
 * it reads sit there, and a read of any other repo file finds nothing, as in
 * a compiled binary.
 */
export const BUNDLE_DIR_SUFFIX = ".bundle";

/**
 * This module, repo-relative: the one module a bundle may hold that reads its
 * own location (`import.meta.url`, above). The bundler refuses any other —
 * in a bundle every module's location is the bundle file's, so a path built
 * from one would point into the bundle at a file that is not there.
 */
export const REPO_ROOT_MODULE = `${OWN_DIR}/repo-root.ts`;

/** Where code runs from, and what kind of root that is. */
type Located = { kind: "checkout" | "compiled" | "bundle"; root: string };

function locate(moduleDir: string, ownDir: string): Located {
  const suffix = `/${ownDir}`;
  if (moduleDir.endsWith(suffix))
    return { kind: "checkout", root: moduleDir.slice(0, -suffix.length) };
  if (moduleDir === COMPILED_ROOT || moduleDir.startsWith(`${COMPILED_ROOT}/`))
    return { kind: "compiled", root: COMPILED_ROOT };
  const parts = moduleDir.split("/");
  const at = parts.findLastIndex((p) => p.endsWith(BUNDLE_DIR_SUFFIX));
  if (at > 0) return { kind: "bundle", root: parts.slice(0, at + 1).join("/") };
  throw new Error(
    `repo-root: this module sits at ${moduleDir}, which does not end with its declared ${ownDir} — the plugin moved and OWN_DIR was not rewritten with it`,
  );
}

/**
 * The checkout root, given the directory of the module at `ownDir` (its
 * repo-relative directory). Strips the suffix rather than climbing a counted
 * number of `../`, so the answer cannot drift from where the module really is.
 * A compiled binary has no checkout: its virtual root is the answer (a read
 * under it finds nothing, as a read of an un-shipped repo file must). Nor
 * has a self-contained bundle: its directory is (`BUNDLE_DIR_SUFFIX`).
 */
export function repoRootOf(moduleDir: string, ownDir: string): string {
  return locate(moduleDir, ownDir).root;
}

const LOCATED = locate(
  decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\/$/, ""),
  OWN_DIR,
);

/**
 * The checkout this code runs from (main's or a worktree's). The one place a
 * file gets the repo root: join a repo-relative path onto it — never count
 * `../` from your own location (`repo-root/no-depth-counted-path`), which
 * encodes your depth and silently re-aims when your plugin moves.
 *
 * Read from `import.meta.url` (not `import.meta.dir`, Bun's own), so a module
 * evaluated by vitest or eslint under Node answers the same.
 */
export const REPO_ROOT: AppPath = asAppPath(LOCATED.root);

/**
 * A script's name in a bundle: a TypeScript script is bundled into the `.js`
 * beside where its source would be; any other file keeps its name.
 */
export function bundledScriptName(rel: string): string {
  return rel.replace(/\.(?:ts|tsx|mts|cts)$/, ".js");
}

/**
 * A file this code runs BY PATH — a `bun <script>` child, a Worker, a shell
 * script — named by its repo-relative path. From a checkout, that file; in a
 * self-contained bundle, the bundle's own copy at the same relative path
 * (`bundledScriptName`). Never build such a path from `import.meta`: in a
 * bundle every module reports the bundle file's location.
 *
 * Always call it with a string literal: the bundler reads the literal to know
 * which scripts a bundle must carry (and refuses a call it cannot read), and
 * `./equin plugin move` rewrites it like any path mention.
 */
export function scriptPath(rel: string): AppPath {
  return joinAppPath(
    REPO_ROOT,
    LOCATED.kind === "bundle" ? bundledScriptName(rel) : rel,
  );
}
