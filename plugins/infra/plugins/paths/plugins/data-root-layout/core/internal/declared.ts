import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  envName,
  readEnv,
  readEnvPath,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  DataRootSplitError,
  homeDataRootLayoutOf,
  homeDataRootLayoutToken,
  readHomeDataRootLayoutSync,
  type DataRootLayout,
} from "./data-root-layout";

// A leaf apart from `infra/paths`' core on purpose: what the data root IS is
// read by code whose identity keys records (the barrel evaluator's load guard
// names the root in every evaluated record's key), and the paths barrel's
// closure is ~300 modules that code never calls. So the layout, and the home
// it is relative to, import nothing but env-names, product-name, user-path
// and timed-fs.

/**
 * The user's home, in the one spelling every path read derives from: resolved
 * (no trailing slash, `.`/`..` collapsed), so a non-canonical `$HOME`
 * (`HOME=/Users/x/`) cannot make the home a browser shortens `~/…` against
 * disagree with the paths host-fs returns (each one `resolve()`d).
 */
export const HOME_DIR = resolve(homedir());

/**
 * Where the root is, and why: named by the environment (`custom`), an install
 * not yet migrated (`legacy`, `LEGACY_IDS.dataDirName`), or the current
 * `~/.equin` (`data-root-layout.ts`).
 *
 * The home-relative half is a fact of the disk, so it is DECLARED once for a
 * whole process tree, at the tree's root, and carried by the environment
 * (`EQUIN_DATA_ROOT_LAYOUT`): the `./equin` wrapper, the gateway for every
 * child it spawns, and each entry point a foreign parent starts (a backend's
 * `bin/`, the CLI's, a hook's, the test preload) call
 * {@link declareDataRootLayoutSync} before anything reads a path. Reading it
 * here is then an environment read, on any thread. An install changes layout
 * only through `./equin data-dir migrate`, which runs with every other process
 * of the app stopped and starts the gateway it restores as a fresh process.
 *
 * The environment is read on every call, for the reason in
 * {@link resolveDataRoot}.
 */
export function dataRootLayout(): DataRootLayout {
  const dir = readEnvPath("DIR");
  if (dir !== undefined) return { kind: "custom", root: dir };
  const declared = readEnv("DATA_ROOT_LAYOUT");
  if (declared !== undefined) return homeDataRootLayoutOf(HOME_DIR, declared);
  // A root that found two data roots left the process undeclared on purpose
  // (the CLI, the hooks): its path reads explain the split, not a missed root.
  if (splitAtDeclaration !== null) throw splitAtDeclaration;
  throw new DataRootUndeclaredError();
}

/**
 * A process read a path before the root of its process tree declared the data
 * root's layout (`EQUIN_DATA_ROOT_LAYOUT`) — a missed root, never something to
 * decide on the spot: deciding reads the disk on whatever thread asked, a
 * backend's included. The fix is at the entry point that started the process
 * (the table in infra/paths CLAUDE.md, § The data root), or at the spawner that
 * dropped the variable from its child's environment.
 */
export class DataRootUndeclaredError extends Error {
  constructor() {
    super(
      `[paths] data root undeclared in this process (pid ${process.pid}, ${process.argv.slice(1, 3).join(" ")}): ` +
        `nothing at the root of its process tree called declareDataRootLayoutSync(), and its environment carries no ` +
        `${envName("DATA_ROOT_LAYOUT")}. Declare it at the process's entry point, or pass the spawner's environment on ` +
        `(infra/paths CLAUDE.md, § The data root). A child of a root that found two data roots is left undeclared ` +
        `too: \`./equin data-dir migrate\` explains the split.`,
    );
    this.name = "DataRootUndeclaredError";
  }
}

/**
 * Decide the home layout from the disk NOW and declare it for this process
 * and every process it starts — the one call a process tree's root makes
 * (see {@link dataRootLayout}). Blocks its thread (2 `lstat` + up to 2
 * `realpath`), so it belongs in an entry point before anything else runs: a
 * `bin/` module, before a backend listens. It always reads the disk, even when
 * the environment already carries a declaration: an entry point's parent can
 * be a long-lived process (a tmux server, Claude Code) holding one from before
 * a migration, and the root of a tree is where a stale answer stops.
 *
 * When `EQUIN_DIR` names the root there is no home layout to decide: an
 * inherited declaration is dropped, so nothing below can fall back to it.
 * Two separate roots (`DataRootSplitError`) drop it too, then throw: an entry
 * point whose commands must still run on a split install (the CLI —
 * `data-dir migrate` explains one — and the hooks) catches it and leaves the
 * process undeclared, so the throw comes on the first path read, as it always
 * did.
 */
export function declareDataRootLayoutSync(): DataRootLayout {
  const dir = readEnvPath("DIR");
  if (dir !== undefined) {
    unsetEnv("DATA_ROOT_LAYOUT");
    return { kind: "custom", root: dir };
  }
  let layout: DataRootLayout;
  try {
    layout = readHomeDataRootLayoutSync(HOME_DIR);
  } catch (err) {
    unsetEnv("DATA_ROOT_LAYOUT");
    if (err instanceof DataRootSplitError) splitAtDeclaration = err;
    throw err;
  }
  splitAtDeclaration = null;
  setEnv("DATA_ROOT_LAYOUT", homeDataRootLayoutToken(layout));
  return layout;
}

/** The split this process's own declaration found, rethrown by every path read. */
let splitAtDeclaration: DataRootSplitError | null = null;
