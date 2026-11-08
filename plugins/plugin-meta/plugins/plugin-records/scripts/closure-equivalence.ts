/**
 * The module graph's static closure against the bundler's (`importClosures`,
 * dynamic imports cut), over every server barrel of this checkout: the same
 * modules, and the same out-edges per module. One-off proof that a reader
 * moved from `Bun.build` onto the graph (server portability, the browser
 * host's inference) answers the same.
 *
 *   ./equin run plugins/plugin-meta/plugins/plugin-records/scripts/closure-equivalence.ts
 */
import { realpathSync } from "@plugins/packages/plugins/timed-fs/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { importClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  buildModuleGraph,
  createMemoryRecordStore,
  outsideFilesAt,
} from "../core";

const root = asAppPath(realpathSync(await getWorktreeRoot()));
const snapshot = await loadRepoSnapshot(root);
const barrels = snapshot
  .all()
  .filter((p) =>
    /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/server\/index\.ts$/.test(p),
  )
  .sort();

let t = performance.now();
const bundler = await importClosures(root, barrels, { dynamicImports: "cut" });
console.log(
  `bundler: ${bundler.modules.size} modules, ${Math.round(performance.now() - t)} ms`,
);

const outside: string[] = [];
const fromDisk = outsideFilesAt(root);
t = performance.now();
const graph = await buildModuleGraph(
  {
    snapshot,
    store: createMemoryRecordStore(),
    readOutside: async (rel) => {
      const content = await fromDisk(rel);
      if (content !== null) outside.push(rel);
      return content;
    },
  },
  barrels,
);
const view = graph.bundledClosure(barrels);
const mine = view.modules;
console.log(
  `graph: ${mine.size} modules, ${Math.round(performance.now() - t)} ms; outside the snapshot: ${outside.length ? outside.join(", ") : "none"}`,
);

const onlyBundler = [...bundler.modules].filter((m) => !mine.has(m)).sort();
const onlyGraph = [...mine].filter((m) => !bundler.modules.has(m)).sort();
console.log(
  `only the bundler: ${onlyBundler.length}`,
  onlyBundler.slice(0, 20),
);
console.log(`only the graph: ${onlyGraph.length}`, onlyGraph.slice(0, 20));

let edgeDiffs = 0;
for (const m of [...bundler.modules].filter((x) => mine.has(x)).sort()) {
  const a = bundler.children(m).join("\n");
  const b = view.children(m).join("\n");
  if (a !== b) {
    if (edgeDiffs++ < 10)
      console.log(
        `edges differ at ${m}:\n  bundler: ${a.split("\n").join(", ")}\n  graph:   ${b.split("\n").join(", ")}`,
      );
  }
}
console.log(`modules with different out-edges: ${edgeDiffs}`);
const unresolved = [...mine].flatMap((m) =>
  graph.modules.get(m)!.unresolved.map((u) => `${m} → ${u}`),
);
console.log(
  `unresolved internal imports in the closure: ${unresolved.length}`,
  unresolved.slice(0, 20),
);
