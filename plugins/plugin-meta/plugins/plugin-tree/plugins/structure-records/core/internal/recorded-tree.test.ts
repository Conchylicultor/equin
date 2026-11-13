import { beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryRecordStore,
  installRecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { overlaySnapshot } from "@plugins/plugin-meta/plugins/plugin-records/core/testing";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { PLUGIN_MANIFEST_KEY } from "@plugins/framework/plugins/plugin-id/core";
import {
  buildPluginTree,
  pluginTreeToJson,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildRecordedPluginTree } from "./recorded-tree";

// The record-backed structure tree is the reading build's tree, and a stored
// key-file fact never outlives a change to that file's bytes.

const PATH = "zz-structure-fixture";
// Through `pj`, never a bare `plugins/<seg>/…` literal: the repo's
// `plugin-refs-resolve` check resolves every such literal to a real plugin.
const pj = (rel: string): string => `plugins/${rel}`;

const barrel = (description: string, extra = "") =>
  `export default {\n  description: ${JSON.stringify(description)},${extra}\n} satisfies PluginDefinition;\n`;

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
  installRecordStore(createMemoryRecordStore());
});

const json = (tree: PluginTree) => JSON.stringify(pluginTreeToJson(tree));

function recorded(repo: RepoSnapshot): Promise<PluginTree> {
  return buildRecordedPluginTree(joinAppPath(repo.root, "plugins"), { repo });
}

describe("buildRecordedPluginTree", () => {
  test("equals the reading build over the real checkout", async () => {
    const reading = await buildPluginTree(joinAppPath(real.root, "plugins"), {
      repo: real,
    });
    expect(json(await recorded(real))).toBe(json(reading));
    // Again, every fact now a stored record.
    expect(json(await recorded(real))).toBe(json(reading));
  });

  test("an edited key file re-answers; a stored fact is not reused", async () => {
    const web = pj(`${PATH}/web/index.ts`);
    const pkg = pj(`${PATH}/package.json`);
    const first = await recorded(
      overlaySnapshot(real, { [web]: barrel("first"), [pkg]: "{}" }),
    );
    expect(first.byPath.get(PATH)?.description).toBe("first");
    expect(first.byPath.get(PATH)?.loadBearing).toBe(false);

    const second = await recorded(
      overlaySnapshot(real, {
        [web]: barrel("second", "\n  loadBearing: true,"),
        [pkg]: JSON.stringify({ [PLUGIN_MANIFEST_KEY]: { collapsed: true } }),
      }),
    );
    const node = second.byPath.get(PATH);
    expect(node?.description).toBe("second");
    expect(node?.loadBearing).toBe(true);
    expect(node?.runtimes.web).toBe(true);
    expect(node?.collapsed).toBe(true);

    // The barrel removed: the package.json's description takes over.
    const third = await recorded(
      overlaySnapshot(real, {
        [pkg]: JSON.stringify({ description: "from package" }),
      }),
    );
    expect(third.byPath.get(PATH)?.description).toBe("from package");
    expect(third.byPath.get(PATH)?.runtimes.web).toBe(false);
  });

  test("a barrel whose description cannot be read fails, stored or not", async () => {
    const web = pj(`${PATH}/web/index.ts`);
    const broken = overlaySnapshot(real, {
      [web]:
        "export default { description: someConst } satisfies PluginDefinition;\n",
    });
    expect(recorded(broken)).rejects.toThrow("not a static string literal");
  });
});
