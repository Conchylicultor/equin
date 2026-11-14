import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { deployedReads, planExpectedFleet, type PlanReads } from "./expected";
import type { FleetSource } from "./plan";
import type { ArtifactEdges, GlobPatternMemo } from "./store";

/** A glob memo that persists nothing. */
function memoryGlobs(): GlobPatternMemo {
  const known = new Map<string, readonly string[]>();
  return {
    get: (blob) => known.get(blob),
    set: (blob, patterns) => void known.set(blob, patterns),
    save: () => {},
  };
}

/** `snapshot`, with `rel`'s content id replaced — the tree after an edit of it. */
function edited(snapshot: RepoSnapshot, rel: string): RepoSnapshot {
  return new Proxy(snapshot, {
    get(target, key) {
      if (key === "blobOf")
        return (path: string) =>
          path === rel ? "e".repeat(40) : target.blobOf(path);
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const NO_EDGES: ArtifactEdges = {
  staticImportsByFile: { "index.js": [] },
  dynamicImports: [],
};

describe("map-in-sync re-plans the tree over the dist's recorded edges", () => {
  const tmp = asAppPath(mkdtempSync(join(tmpdir(), "expected-edges-test-")));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const registryFile = joinAppPath(tmp, "web.composition.edges.generated.ts");
  writeFileSync(registryFile, "export const webEntries = [];\n");
  const source: FleetSource = {
    webEntries: [{ pluginPath: "shell", id: "shell", dependsOn: [] }],
    webScopedEntries: [],
    deferredPaths: new Set<string>(),
    registryFile,
    registrySlug: "web-registry-edges",
  };
  const plan = (repo: RepoSnapshot, reads: PlanReads) =>
    planExpectedFleet({
      repo,
      minify: true,
      source,
      reads,
      globs: memoryGlobs(),
    });

  test("the plan reads only the dist's record: in sync ⇒ nothing missing; an edit ⇒ exactly what it re-addressed, whatever the store holds", async () => {
    const snapshot = await loadRepoSnapshot(REPO_ROOT);
    // A store that holds every address the tree could plan, counting what it
    // is asked: the shared, machine-wide state the verdict must not depend on.
    const storeAsked: string[] = [];
    const store: PlanReads = {
      edges: async (dirName) => {
        storeAsked.push(dirName);
        return NO_EDGES;
      },
      hostRecords: () => [],
    };
    // The deploy: every address the tree plans, with its edges recorded.
    const deployed = await plan(snapshot, store);
    expect(deployed.missing).toEqual([]);
    const recorded = new Map(deployed.metas);
    expect(recorded.size).toBeGreaterThan(0);
    storeAsked.length = 0;

    const dist = deployedReads({ edges: recorded, imports: {} });
    const same = await plan(snapshot, dist);
    expect(same.missing).toEqual([]);

    // An edit to shell's web barrel re-addresses its web artifact: the dist
    // does not name the new address — the stale verdict, even though the
    // store holds it.
    const stale = await plan(
      edited(snapshot, "plugins/shell/web/index.ts"),
      dist,
    );
    expect(stale.missing).toHaveLength(1);
    const [changed] = stale.missing;
    expect(changed!.startsWith("shell.web.")).toBe(true);
    expect(recorded.has(changed!)).toBe(false);
    expect(storeAsked).toEqual([]);
  });
});
