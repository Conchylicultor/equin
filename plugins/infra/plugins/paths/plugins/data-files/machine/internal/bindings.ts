import {
  defineServerContribution,
  type Registration,
  type ServerContribution,
} from "@plugins/framework/plugins/server-core/core";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import type { DataDir } from "@plugins/infra/plugins/paths/core";
import { defineAgentWriteLedger } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import {
  listFileRoots,
  type FileRoot,
  type FileRootSpec,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import type { Mount } from "../../core";
import {
  createDiskDataFiles,
  restoreLedgerEntry,
  type BoundRoot,
  type LedgerFile,
} from "./disk-store";
import { diskTree } from "./disk-tree";

const locationToken = defineServerContribution<{
  root: FileRoot;
  dataDir: DataDir;
}>("data-files.root-location", { docLabel: (p) => p.root.id });

/**
 * Where a declared file root lives on this computer: the data dir it names.
 * Contributed by the owner's `machine/` half — the half that may import its
 * `data-dirs` — so the portable root never holds a path, and the pair is typed.
 * At boot every declared root must have exactly one, naming the dir its spec
 * says (`root.dir`): else boot fails.
 */
export function FileRootLocation(
  root: FileRoot,
  dataDir: DataDir,
): ServerContribution {
  return locationToken({ root, dataDir });
}

const dirRefOf = (dataDir: DataDir): string =>
  `${dataDir.spec.kind}/${dataDir.spec.name}`;

// Filled by the register phase: every booted root's binding, by id.
let bound: ReadonlyMap<string, BoundRoot> | null = null;

/**
 * Pair every declared root with its one location, or say which are wrong:
 * unbound, bound twice, or bound to another data dir than the one it names.
 * Pure over its inputs, so a test can hand it literals.
 */
export function rootBindingProblems(
  roots: readonly FileRootSpec[],
  locations: readonly {
    root: FileRoot;
    dataDir: DataDir;
    _pluginId?: string;
  }[],
): string[] {
  const problems: string[] = [];
  for (const spec of roots) {
    const mine = locations.filter((l) => l.root.id === spec.id);
    const by = mine.map((l) => l._pluginId ?? "(unknown plugin)").join(", ");
    if (mine.length === 0) {
      problems.push(
        `file root "${spec.id}" has no FileRootLocation — its owner's machine/ must contribute FileRootLocation(<root>, <its "${spec.dir}" data dir>)`,
      );
    } else if (mine.length > 1) {
      problems.push(
        `file root "${spec.id}" has ${mine.length} FileRootLocations (${by}) — a root lives in one place`,
      );
    } else if (dirRefOf(mine[0]!.dataDir) !== spec.dir) {
      problems.push(
        `file root "${spec.id}" names data dir "${spec.dir}" but ${by} binds it to "${dirRefOf(mine[0]!.dataDir)}"`,
      );
    }
  }
  return problems;
}

/**
 * The register phase's half of the desktop provider: assert every declared
 * root is bound (every barrel has loaded by now, so every root is declared),
 * then mount one declared file watcher per root that watches — named and
 * described by the root, so the Background catalog lists it — and one
 * agent-write ledger per root that keeps one.
 */
export const fileRootBindings: Registration = {
  _doc: {
    label: "file-root bindings",
    detail:
      "Binds every declared file root to its data dir; mounts each root's watcher and ledger",
  },
  register() {
    const roots = listFileRoots();
    const locations = locationToken.getContributions();
    const problems = rootBindingProblems(
      roots.map((r) => r.spec),
      locations,
    );
    if (problems.length > 0) {
      throw new Error(`[data-files] ${problems.join("\n")}`);
    }
    const next = new Map<string, BoundRoot>();
    for (const { root, dataDir } of locations) {
      const watch = root.spec.watch;
      const watcher =
        watch === undefined
          ? null
          : defineFileWatcher({
              name: watch.name,
              description: watch.description,
              extensions:
                watch.extensions === undefined
                  ? undefined
                  : [...watch.extensions],
            });
      watcher?.register();
      const ledgerSpec = root.spec.ledger;
      const ledger =
        ledgerSpec === undefined
          ? null
          : defineAgentWriteLedger<LedgerFile>({
              id: ledgerSpec.id,
              label: ledgerSpec.label,
              restore: restoreLedgerEntry,
            });
      next.set(root.id, { dir: () => dataDir.path, watcher, ledger });
    }
    bound = next;
  },
};

/** The desktop's DataFiles provider, over the roots the register phase bound. */
export const diskDataFiles = createDiskDataFiles({
  bound: (spec) => {
    if (bound === null) {
      throw new Error(
        `[data-files] root "${spec.id}" used before the register phase bound the file roots`,
      );
    }
    const binding = bound.get(spec.id);
    if (binding === undefined) {
      throw new Error(
        `[data-files] root "${spec.id}" is not bound in this process — it was declared after boot, or never contributed`,
      );
    }
    return binding;
  },
});

/**
 * A data dir's files as a {@link Mount}, for a process that boots no plugin
 * graph (a `cli/` command): the same disk operations and lock files a root's
 * provider uses, without its watch or ledger.
 */
export function diskMount(dataDir: DataDir): Mount {
  return diskTree({
    dir: () => dataDir.path,
    label: `data dir "${dirRefOf(dataDir)}"`,
  });
}

/**
 * A directory of this computer that is NOT a data dir, as a {@link Mount} —
 * for a host process reading checkout files a data dir is filled from (the
 * prototypes template a mint copies) or a check reads (the repo's
 * `prototypes/`). The same disk operations as {@link diskMount}; no watch, no
 * ledger. Never for a data dir: that is a root, or `diskMount`.
 */
export function diskDirMount(dir: string): Mount {
  return diskTree({ dir: () => dir, label: `directory "${dir}"` });
}
