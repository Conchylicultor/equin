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
export async function backendEntries(
  repo: RepoFiles,
): Promise<
  { ok: true; entries: string[] } | { ok: false; result: CheckResult }
> {
  const entries = [BIN_ENTRY];
  for (const registry of REGISTRIES) {
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
