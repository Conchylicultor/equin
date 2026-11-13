import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
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
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { exportsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/exports/core";
import { buildFacetedPluginTree } from "./faceted-tree";

// Two faceted trees over one set share its facet record texts (read once),
// yet each holds its own data; a new set — an edit — reads its own.

// A cold store extracts every plugin's facets once (on workers).
setDefaultTimeout(180_000);

const PLUGIN = "hints/plugins/help-menu";
// Through a template, never a bare `plugins/<seg>/…` literal: the repo's
// `plugin-refs-resolve` check resolves every such literal to a real plugin.
const barrelPath = `${"plugins"}/${PLUGIN}/web/index.ts`;

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
  installRecordStore(createMemoryRecordStore());
});

const build = (repo: RepoSnapshot): Promise<PluginTree> =>
  buildFacetedPluginTree(joinAppPath(repo.root, "plugins"), { repo });

const exportsOf = (tree: PluginTree): unknown =>
  getFacet(tree.byPath.get(PLUGIN)!, exportsFacetDef);

test("a second tree over one set has the same facets, in its own objects", async () => {
  const first = await build(real);
  const second = await build(real);
  expect(second.byDir.size).toBe(first.byDir.size);
  for (const [dir, node] of first.byDir) {
    const other = second.byDir.get(dir)!;
    for (const facet of first.facets) {
      const a = getFacet(node, facet.def);
      const b = getFacet(other, facet.def);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      if (a !== null && typeof a === "object") expect(b).not.toBe(a);
    }
  }
});

test("an edited plugin's facets re-answer over the edited set", async () => {
  const before = JSON.stringify(exportsOf(await build(real)));
  expect(before).not.toContain("facetRecordsProbe");
  const original = await real.read(barrelPath);
  const edited = overlaySnapshot(real, {
    [barrelPath]: `${original}\nexport type facetRecordsProbe = 1;\n`,
  });
  expect(JSON.stringify(exportsOf(await build(edited)))).toContain(
    "facetRecordsProbe",
  );
  // The original set still answers what it held.
  expect(JSON.stringify(exportsOf(await build(real)))).toBe(before);
});
