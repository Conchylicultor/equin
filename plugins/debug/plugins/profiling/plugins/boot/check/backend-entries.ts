import { CENTRAL_ENTRY } from "@plugins/build/plugins/central-build-id/core";
import type {
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { fileSetImports } from "@plugins/plugin-meta/plugins/plugin-records/core";

/** The serving backend's composition root. */
export const BIN_ENTRY = "plugins/framework/plugins/server-core/bin/index.ts";
// eslint-disable-next-line exempt/no-path-allowlist -- the registries whose members a backend boots, not an allowlist of violators
const REGISTRIES = [
  "plugins/framework/plugins/server-core/core/server.generated.ts",
  "plugins/framework/plugins/server-core/core/machine.generated.ts",
];
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

/** Central's composition root — the one entry central's code build digests. */
const CENTRAL_BIN_ENTRY = CENTRAL_ENTRY;
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
  for (const registry of registries) {
    if (!repo.has(registry)) {
      return {
        ok: false,
        result: {
          ok: false,
          message: `${registry} is missing — run ./equin build`,
        },
      };
    }
  }
  // A registry entry's barrels are its loaders' `import()`s — its `loader`'s
  // `<runtime>` barrel and its `core` loader's — read off the module graph
  // in source order, so the first barrel reaching a finding is charged.
  const barrels = await fileSetImports(repo, registries, { edges: "dynamic" });
  return {
    ok: true,
    entries: [bin, ...registries.flatMap((r) => barrels.get(r)!)],
  };
}
