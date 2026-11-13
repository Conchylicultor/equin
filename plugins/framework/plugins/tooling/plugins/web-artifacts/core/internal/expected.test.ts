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
import {
  deployedEdgesReader,
  planExpectedFleet,
  type EdgesReader,
} from "./expected";
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
  const plan = (repo: RepoSnapshot, readEdges: EdgesReader) =>
    planExpectedFleet({
      repo,
      minify: true,
      source,
      readEdges,
      globs: memoryGlobs(),
    });

  /** A store holding nothing, counting what it is asked. */
  function emptyStore(): { read: EdgesReader; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      read: async (dirName) => {
        asked.push(dirName);
        return null;
      },
    };
  }

  test("a tree in sync with the dist reads nothing from the store; an edit reads — and misses — only what it re-addressed", async () => {
    const snapshot = await loadRepoSnapshot(REPO_ROOT);
    // The deploy: every address the tree plans, with its edges recorded.
    const deployed = await plan(snapshot, async () => NO_EDGES);
    expect(deployed.missing).toEqual([]);
    const recorded = new Map(deployed.metas);
    expect(recorded.size).toBeGreaterThan(0);

    const inSync = emptyStore();
    const same = await plan(
      snapshot,
      deployedEdgesReader(recorded, inSync.read),
    );
    expect(same.missing).toEqual([]);
    expect(inSync.asked).toEqual([]);

    // An edit to shell's web barrel re-addresses its web artifact: the dist
    // does not name the new address, the store lacks it — the stale verdict.
    const afterEdit = emptyStore();
    const stale = await plan(
      edited(snapshot, "plugins/shell/web/index.ts"),
      deployedEdgesReader(recorded, afterEdit.read),
    );
    expect(stale.missing).toHaveLength(1);
    const [changed] = stale.missing;
    expect(changed!.startsWith("shell.web.")).toBe(true);
    expect(recorded.has(changed!)).toBe(false);
    expect(afterEdit.asked).toEqual([changed!]);
  });
});
