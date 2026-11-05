import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  pluginTreeFromJson,
  type PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Wedge-breaker, far above a cold build (every plugin's facets extracted with
 * no record to read: ~10 s of CPU on a quiet machine).
 */
const FACETED_TREE_TIMEOUT_MS = 10 * 60_000;

/**
 * The faceted tree of this checkout, built by `./equin plugin-tree-facets`
 * (`plugin-tree/faceted`) in a child and read back from the file it wrote — a
 * file rather than stdout, because a CLI that finds its dependencies stale
 * prints the install on stdout first. The child reads the shared plugin
 * records, as a build does, so only plugins changed since their records were
 * made are extracted again.
 */
export async function readFacetedTree(): Promise<PluginTreeData> {
  const dir = await mkdtemp(join(tmpdir(), "equin-facets-tree-"));
  try {
    const out = join(dir, "tree.json");
    await spawnExpectOk([`./${CLI_NAME}`, "plugin-tree-facets", out], {
      cwd: REPO_ROOT,
      timeoutMs: FACETED_TREE_TIMEOUT_MS,
    });
    return pluginTreeFromJson(
      PLUGINS_DIR,
      JSON.parse(await readFile(out, "utf8")) as unknown,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
