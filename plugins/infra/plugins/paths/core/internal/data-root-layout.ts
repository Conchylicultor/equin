import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_IDS,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";

// Where the data root is when the environment does not say: decided by what is
// INSTALLED, not by the code's version.
//
// The root moved from `~/<legacy dir>` to `~/.equin`. Choosing by code version
// would point new code at an empty `~/.equin` on every machine that has not run
// `./equin data-dir migrate` yet — a second, empty install beside the real one.
// So the legacy dir is used while it is there, and only the migration (which
// moves it, with everything stored inside it) switches an install over. A fresh
// machine has no legacy dir and starts on `~/.equin`.
//
// Design: research/2026-10-26-global-equin-data-dir-migration-v2.md
//
// Mirrored, with the same rule and the same cases, by `gateway/main.go`
// (`dataRoot`), `install.sh` and the host scripts that list `dataDirName` as a
// mirror in `framework/product-name`'s `LEGACY_IDS`.

/** The data root's dir name under the home dir: `.equin`. */
export const DATA_DIR_NAME = `.${PRODUCT_NAME}`;

/** Both home-relative roots, current first. */
export function homeDataRoots(home: string): {
  current: string;
  legacy: string;
} {
  return {
    current: join(home, DATA_DIR_NAME),
    legacy: join(home, LEGACY_IDS.dataDirName),
  };
}

/**
 * What sits at one candidate root, as the decision reads it: nothing, a link
 * (with what it resolves to, or null when it dangles), or anything else (a
 * directory — or a file, which the decision treats as occupied too).
 */
export type RootEntry =
  | { kind: "absent" }
  | { kind: "link"; resolved: string | null }
  | { kind: "present"; resolved: string };

export type DataRootLayout =
  /** The environment names the root (a release bundle, a preview, a VM). */
  | { kind: "custom"; root: string }
  /** An install not yet migrated: the root is the legacy dir. */
  | { kind: "legacy"; root: string; current: string }
  /**
   * The current root. `legacyLink` is true while the legacy name is still a
   * link to it — the migration's own safety net, left only when its leftover
   * scan was not clean.
   */
  | { kind: "current"; root: string; legacy: string; legacyLink: boolean };

/**
 * Both names hold separate data: a legacy root that is not a link to the
 * current one, and a current root beside it. There is no correct automatic
 * answer — picking either would hide the other's data — so nothing proceeds.
 */
export class DataRootSplitError extends Error {
  constructor(
    readonly legacy: string,
    readonly current: string,
  ) {
    super(
      `Two data roots: ${legacy} and ${current} both exist and are not the same directory. ` +
        `An install not yet migrated keeps its data in ${legacy}; ${current} is what \`./equin data-dir migrate\` moves it to. ` +
        `Look at what ${current} holds (\`ls -la ${current}\`): if it is empty or stray, remove it; otherwise move whichever one you want to keep aside, then retry.`,
    );
    this.name = "DataRootSplitError";
  }
}

/**
 * The decision, pure: from what sits at both names to the layout.
 *
 * - legacy absent → current (a fresh install, or a migrated one);
 * - legacy a link resolving to the current root → current (a migration whose
 *   leftover scan kept the link);
 * - legacy anything else (a directory, or a link to elsewhere, e.g. an external
 *   disk the user moved it to) → legacy — unless the current root exists too,
 *   which is a split and throws.
 */
export function decideDataRootLayout(
  roots: { current: string; legacy: string },
  entries: { current: RootEntry; legacy: RootEntry },
): DataRootLayout {
  const { current, legacy } = entries;
  if (legacy.kind === "absent") {
    return {
      kind: "current",
      root: roots.current,
      legacy: roots.legacy,
      legacyLink: false,
    };
  }
  const currentResolved =
    current.kind === "present"
      ? current.resolved
      : current.kind === "link"
        ? current.resolved
        : null;
  if (
    legacy.kind === "link" &&
    legacy.resolved !== null &&
    legacy.resolved === currentResolved
  ) {
    return {
      kind: "current",
      root: roots.current,
      legacy: roots.legacy,
      legacyLink: true,
    };
  }
  if (current.kind !== "absent") {
    throw new DataRootSplitError(roots.legacy, roots.current);
  }
  return { kind: "legacy", root: roots.legacy, current: roots.current };
}

/** What sits at `path`, read without following a final link. */
export function readRootEntry(path: string): RootEntry {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  let resolved: string | null;
  try {
    resolved = realpathSync(path);
  } catch (err) {
    if (isLink && (err as NodeJS.ErrnoException).code === "ENOENT") {
      resolved = null;
    } else {
      throw err;
    }
  }
  if (isLink) return { kind: "link", resolved };
  if (resolved === null)
    throw new Error(`unreachable: ${path} has no realpath`);
  return { kind: "present", resolved };
}

/** The home-relative layout as it is on disk now — read fresh, never cached. */
export function readHomeDataRootLayout(home: string): DataRootLayout {
  const roots = homeDataRoots(home);
  return decideDataRootLayout(roots, {
    current: readRootEntry(roots.current),
    legacy: readRootEntry(roots.legacy),
  });
}
