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
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type {
  PluginNode,
  PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { readDeclaredApps } from "./declared-apps";

// The apps a tree declares are plugin records (a fold over every plugin's
// `core/*.ts`). A stored part must never outlive a change to its bytes: an
// edited `defineApp` re-answers, and a plugin's app is its first `core/` file
// by name that declares one.

const PATH = "zz-apps-fixture";
// Through `pj`, never a bare `plugins/<seg>/…` literal: the repo's
// `plugin-refs-resolve` check resolves every such literal to a real plugin.
const pj = (rel: string): string => `plugins/${rel}`;

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
});

function treeOver(files: Record<string, string>): PluginTree {
  const repo = overlaySnapshot(real, files);
  const pluginsRoot = joinAppPath(repo.root, "plugins");
  const node: PluginNode = {
    dir: joinAppPath(pluginsRoot, PATH),
    path: PATH,
    name: PATH,
    id: asPluginId(PATH),
    descriptions: {},
    loadBearing: false,
    collapsed: false,
    compositionRoot: false,
    runtimes: { web: false, server: false, machine: false, central: false },
    children: [],
    facets: {},
  };
  return {
    pluginsRoot,
    byDir: new Map([[node.dir, node]]),
    byPath: new Map([[node.path, node]]),
    roots: [node],
    facets: [],
    repo,
  };
}

const app = (id: string) =>
  `export const app = defineApp({ id: "${id}", icon: symbol("home") });\n`;

describe("readDeclaredApps' records", () => {
  test("an edited defineApp re-answers", async () => {
    installRecordStore(createMemoryRecordStore());
    const ids = async (files: Record<string, string>) =>
      [...(await readDeclaredApps(treeOver(files))).entries()].map(
        ([id, a]) => `${id} ${a.iconKey} ${a.plugin}`,
      );
    expect(await ids({ [pj(`${PATH}/core/app.ts`)]: app("zz-a") })).toEqual([
      `zz-a home ${PATH}`,
    ]);
    expect(await ids({ [pj(`${PATH}/core/app.ts`)]: app("zz-b") })).toEqual([
      `zz-b home ${PATH}`,
    ]);
    expect(
      await ids({ [pj(`${PATH}/core/app.ts`)]: "export const x = 1;\n" }),
    ).toEqual([]);
  });

  test("a plugin's app is its first core file by name; tests and plugins outside the tree never count", async () => {
    installRecordStore(createMemoryRecordStore());
    const apps = await readDeclaredApps(
      treeOver({
        [pj(`${PATH}/core/b.ts`)]: app("zz-second"),
        [pj(`${PATH}/core/a.ts`)]: app("zz-first"),
        [pj(`${PATH}/core/a.test.ts`)]: app("zz-test"),
        [pj("zz-not-in-tree/core/app.ts")]: app("zz-outside"),
      }),
    );
    expect([...apps.keys()]).toEqual(["zz-first"]);
  });

  test("a defineApp without a literal id throws, naming the file", () => {
    installRecordStore(createMemoryRecordStore());
    expect(
      readDeclaredApps(
        treeOver({
          [pj(`${PATH}/core/app.ts`)]: "export const a = defineApp({ id });\n",
        }),
      ),
    ).rejects.toThrow(/without a string-literal `id`/);
  });
});
