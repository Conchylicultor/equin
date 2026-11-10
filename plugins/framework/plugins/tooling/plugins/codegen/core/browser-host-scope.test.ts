/**
 * What a composition carries on demand, over the real repo: main bundles
 * every plugin, so nothing; the standalone website bundles the workspace
 * demo's declaring plugin, so the demo's page scope beyond the site's own
 * plugins — web plugins only, none of them in the site's bundle (its
 * backend), and the web registry renders them as `webScopedEntries`.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import {
  loadRepoSnapshot,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { discoverCollectedDirsIn } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import {
  discoverBrowserHosts,
  resolveHostScope,
  scopedOnlyWebPlugins,
} from "./browser-host-scope";
import { readCompositionManifestsFromDisk } from "./main-bundle";
import {
  buildRegistryGenContext,
  renderCollectedDirRegistry,
} from "./plugin-registry-gen";
import { codegenPassOver } from "./codegen-pass";

setDefaultTimeout(300_000);

const DEMO = "apps/plugins/website/plugins/demos/plugins/workspace";

async function repoContext() {
  const root = await getWorktreeRoot();
  return buildRegistryGenContext(codegenPassOver(await loadRepoSnapshot(root)));
}

describe("scopedOnlyWebPlugins over the repo", () => {
  test("main carries nothing on demand: it bundles every scope", async () => {
    const ctx = await repoContext();
    expect(await scopedOnlyWebPlugins(ctx, ctx.mainBundle)).toEqual([]);
  });

  test("the website carries the demo's page scope beyond its own plugins, web plugins only", async () => {
    const ctx = await repoContext();
    const manifests = readCompositionManifestsFromDisk(ctx.root);
    const row = manifests.find((m) => m.id === "website")!;
    const bundle = resolveComposition(
      ctx.graph,
      flattenManifest(
        manifestItemToManifest(row),
        manifests.map(manifestItemToManifest),
      ),
    ).bundle;
    const host = discoverBrowserHosts(await ctx.repo()).find(
      (h) => h.pluginPath === DEMO,
    )!;
    const scope = await resolveHostScope(ctx, host);
    const scoped = await scopedOnlyWebPlugins(ctx, bundle);

    // The demo's apps reach the site's page as its scope, never its backend.
    expect(scoped).toContain(asPluginId("apps.agent-manager.shell"));
    expect(scoped).toContain(asPluginId("conversations"));
    for (const id of scoped) {
      expect(bundle.has(id)).toBe(false);
      expect(scope.webPlugins).toContain(id);
    }
    // What the scope shares with the site stays the site's own.
    for (const id of scope.webPlugins) {
      expect(bundle.has(id) || scoped.includes(id)).toBe(true);
    }

    // …and the site's web registry lists them apart, as `webScopedEntries`.
    const repo: RepoFiles = await ctx.repo();
    const web = (await discoverCollectedDirsIn(repo)).find(
      (d) => d.dir === "web",
    )!;
    const rendered = await renderCollectedDirRegistry({
      ctx,
      def: web,
      bundle: new Set(bundle),
      composition: { id: "website", home: "website", unlisted: [] },
    });
    const [own, onDemand] = rendered.split(
      "export const webScopedEntries: CollectedEntry[] = [",
    );
    expect(onDemand).toBeDefined();
    expect(own).not.toContain('id: "apps.agent-manager.shell"');
    expect(onDemand).toContain('id: "apps.agent-manager.shell"');
  });
});
