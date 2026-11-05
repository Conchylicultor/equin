import type {
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";

/** The serving backend's composition root. */
export const BIN_ENTRY = "plugins/framework/plugins/server-core/bin/index.ts";
// eslint-disable-next-line exempt/no-path-allowlist -- the registries whose members a backend boots, not an allowlist of violators
const REGISTRIES = [
  "plugins/framework/plugins/server-core/core/server.generated.ts",
  "plugins/framework/plugins/server-core/core/machine.generated.ts",
];
/** A registry entry's barrel — its `loader`'s `import("@plugins/<path>/<runtime>")`,
 *  or its `core` loader's `import("@plugins/<path>/core")`. */
const ENTRY_RE = /import\("@plugins\/([^"]+)"\)/g;

/**
 * What a backend boots: its bin plus every barrel the registries list — each
 * server and machine barrel, and the core barrel the load waves warm before
 * it — so each finding is charged to the plugin whose barrel reaches it
 * (rather than all of them to the bin, which reaches every registry). The main
 * composition's bin stands for every composition's entry: they differ only in
 * which registries they import (codegen's `renderBackendEntry`). A failed result when a
 * registry or a barrel it names is missing — a build is due.
 */
export function backendEntries(
  repo: RepoFiles,
): Promise<
  { ok: true; entries: string[] } | { ok: false; result: CheckResult }
> {
  return entriesOf(repo, BIN_ENTRY, REGISTRIES);
}

/** Central's composition root. */
const CENTRAL_BIN_ENTRY = "plugins/framework/plugins/central-core/bin/index.ts";
// eslint-disable-next-line exempt/no-path-allowlist -- the registry whose members central boots, not an allowlist of violators
const CENTRAL_REGISTRIES = [
  "plugins/framework/plugins/central-core/core/central.generated.ts",
];

/** What central boots, the same way: its bin plus every barrel its registry lists. */
export function centralEntries(
  repo: RepoFiles,
): Promise<
  { ok: true; entries: string[] } | { ok: false; result: CheckResult }
> {
  return entriesOf(repo, CENTRAL_BIN_ENTRY, CENTRAL_REGISTRIES);
}

async function entriesOf(
  repo: RepoFiles,
  bin: string,
  registries: readonly string[],
): Promise<
  { ok: true; entries: string[] } | { ok: false; result: CheckResult }
> {
  const entries = [bin];
  for (const registry of registries) {
    const src = await repo.read(registry);
    if (src === null) {
      return {
        ok: false,
        result: {
          ok: false,
          message: `${registry} is missing — run ./equin build`,
        },
      };
    }
    for (const m of src.matchAll(ENTRY_RE)) {
      const dir = `plugins/${m[1]}`;
      const barrel = [`${dir}/index.ts`, `${dir}/index.tsx`].find((f) =>
        repo.has(f),
      );
      if (barrel === undefined) {
        return {
          ok: false,
          result: {
            ok: false,
            message: `${registry} names ${dir}, which has no index.ts — run ./equin build`,
          },
        };
      }
      entries.push(barrel);
    }
  }
  return { ok: true, entries };
}
