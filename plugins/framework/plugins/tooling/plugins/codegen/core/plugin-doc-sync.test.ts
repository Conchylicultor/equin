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
import { firstStalePluginDoc, renderPluginClaudeMd } from "./docgen";
import type { MainComposition } from "./main-bundle";

// `firstStalePluginDoc` judges each CLAUDE.md from a fold record of its bytes.
// It must agree with re-splicing the file: a block edit is stale, a prose edit
// is not, and a stored answer never outlives an edit of the file.

const PATH = "zz-doc-sync-fixture";
// Through `pj`, never a bare `plugins/<seg>/…` literal: the repo's
// `plugin-refs-resolve` check resolves every such literal to a real plugin.
const pj = (rel: string): string => `plugins/${rel}`;
const CLAUDE = pj(`${PATH}/CLAUDE.md`);
const REFERENCE = pj(`${PATH}/REFERENCE.md`);

const main: MainComposition = {
  bundle: new Set([asPluginId(PATH)]),
  negated: new Set(),
  home: "home",
  unlisted: [],
};

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
  installRecordStore(createMemoryRecordStore());
});

function treeOver(repo: RepoSnapshot): PluginTree {
  const pluginsRoot = joinAppPath(repo.root, "plugins");
  const node: PluginNode = {
    dir: joinAppPath(pluginsRoot, PATH),
    path: PATH,
    name: PATH,
    id: asPluginId(PATH),
    description: "A fixture.",
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

/** The CLAUDE.md the generator writes for the fixture, around `prose`. */
function synced(prose: string): string {
  const tree = treeOver(real);
  return renderPluginClaudeMd(tree.roots[0]!, prose, real.root, [], real, main);
}

async function judge(files: Record<string, string>) {
  const repo = overlaySnapshot(real, files);
  return await firstStalePluginDoc(treeOver(repo), repo, main);
}

describe("firstStalePluginDoc", () => {
  test("a generated file is in sync; its prose is the author's", async () => {
    expect(
      await judge({ [CLAUDE]: synced("# fixture\n\nProse.\n") }),
    ).toBeNull();
    expect(
      await judge({ [CLAUDE]: synced("# fixture\n\nOther prose.\n") }),
    ).toBeNull();
  });

  test("an edited block is stale, after the synced bytes were folded", async () => {
    const good = synced("# fixture\n\nProse.\n");
    expect(await judge({ [CLAUDE]: good })).toBeNull();
    const edited = good.replace("A fixture.", "A hand edit.");
    expect(edited).not.toBe(good);
    expect((await judge({ [CLAUDE]: edited }))?.rel).toBe(CLAUDE);
    // And back: the earlier record answers again.
    expect(await judge({ [CLAUDE]: good })).toBeNull();
  });

  test("a missing CLAUDE.md, or one the splice would rewrite, is stale", async () => {
    expect((await judge({}))?.rel).toBe(CLAUDE);
    expect(
      (await judge({ [CLAUDE]: `${synced("# fixture\n")}`.trimEnd() }))?.rel,
    ).toBe(CLAUDE);
  });

  test("a REFERENCE.md for a plugin that summarizes no list is stale", async () => {
    const found = await judge({
      [CLAUDE]: synced("# fixture\n"),
      [REFERENCE]: "# leftover\n",
    });
    expect(found?.rel).toBe(REFERENCE);
  });
});
