// Faceted tree, cold and per edit. Before: every file event under `plugins/`
// spawned `./equin plugin-tree-facets`, which built the whole tree again — a
// whole snapshot, the structure, every plugin's record keys and reads, relate,
// a 7.8 MB JSON round trip — on top of its own process boot and tooling load.
// "before" measures that in-process work (records warm), a floor of what the
// child cost. After: the faceted-tree worker's cold build once, then its
// refreshes — and its tree after every edit equals a fresh build.
// `./equin run plugins/plugin-meta/plugins/plugin-tree/scripts/bench-faceted-index.ts [--rounds N] [--skip-old]`
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import {
  pluginTreeFromDelta,
  pluginTreeToJson,
  type PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { FromWorkerFrame, ToWorkerFrame } from "../shared/protocol";

const argv = process.argv.slice(2);
const ROUNDS = Number(argv[argv.indexOf("--rounds") + 1] || 3);
const SKIP_OLD = argv.includes("--skip-old");
const root = await getWorktreeRoot();
const pluginsRoot = joinAppPath(root, "plugins");
const fmt = (ms: number[]) =>
  ms.map((m) => m.toFixed(0).padStart(6)).join(" ") + " ms";

const store = openRecordStore();
installRecordStore(store);
if (!SKIP_OLD) {
  const old: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const s = performance.now();
    const tree = await buildFacetedPluginTree(pluginsRoot, {
      repo: await loadRepoSnapshot(root),
    });
    JSON.parse(JSON.stringify(pluginTreeToJson(tree)));
    store.flush();
    old.push(performance.now() - s);
  }
  console.log("before: per change, in-process ", fmt(old));
}

const worker = new Worker(
  new URL("../bin/faceted-tree-worker.ts", import.meta.url),
);
const frames: FromWorkerFrame[] = [];
let wake: (() => void) | null = null;
worker.onmessage = (e: MessageEvent<FromWorkerFrame>) => {
  frames.push(e.data);
  wake?.();
};
async function next(): Promise<FromWorkerFrame> {
  while (frames.length === 0) await new Promise<void>((r) => (wake = r));
  const f = frames.shift()!;
  if (f.type === "failed") throw new Error(f.message);
  return f;
}
const send = (f: ToWorkerFrame) => worker.postMessage(f);

let s = performance.now();
send({ type: "init", root });
const ready = await next();
if (ready.type !== "ready") throw new Error("expected ready");
let tree: PluginTreeData = pluginTreeFromDelta(pluginsRoot, ready.delta, null);
console.log(
  `after: cold build ${(performance.now() - s).toFixed(0)} ms (in worker ${ready.ms.toFixed(0)} ms), ${tree.byPath.size} nodes`,
);

const BARREL = "plugins/fullscreen/web/index.ts";
const BODY = "plugins/fullscreen/web/components/fullscreen-toggle.tsx";
const NEW = "plugins/fullscreen/web/components/bench-probe.ts";
const barrelText = await readFile(join(root, BARREL), "utf8");
const bodyText = await readFile(join(root, BODY), "utf8");
let id = 0;
async function refresh(
  label: string,
  paths: string[],
  edited: string[],
  ms: number[],
): Promise<void> {
  const s = performance.now();
  send({ type: "refresh", id: ++id, paths, edited });
  const f = await next();
  if (f.type !== "refreshed") throw new Error("expected refreshed");
  if (f.result.kind === "code-changed")
    throw new Error(`code changed: ${f.result.path}`);
  if (f.result.kind === "changed")
    tree = pluginTreeFromDelta(pluginsRoot, f.result.delta, tree);
  ms.push(performance.now() - s);
  if (ms.length === 1 && !label.endsWith("(reverted)"))
    console.log(
      `  ${label}: ${f.result.kind}${f.result.kind === "changed" ? ` (${f.result.nodes} nodes)` : ""}`,
    );
}

const cases: [string, () => Promise<void>][] = [
  ["unrelated save (no write)", async () => {}],
  [
    "function body edited",
    () => writeFile(join(root, BODY), `${bodyText}\n// probe\n`),
  ],
  [
    "barrel export added",
    () =>
      writeFile(
        join(root, BARREL),
        `${barrelText}\nexport type BenchProbe = 1;\n`,
      ),
  ],
];
try {
  for (const [label, edit] of cases) {
    const ms: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      await edit();
      await refresh(
        label,
        [],
        [label.startsWith("barrel") ? BARREL : BODY],
        ms,
      );
      await writeFile(join(root, BARREL), barrelText);
      await writeFile(join(root, BODY), bodyText);
      await refresh(`${label} (reverted)`, [], [BARREL, BODY], []);
    }
    console.log(`after: ${label.padEnd(28)}`, fmt(ms));
  }
  const created: number[] = [];
  const deleted: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await writeFile(join(root, NEW), "export const benchProbe = 1;\n");
    await refresh("file created", [NEW], [], created);
    await rm(join(root, NEW));
    await refresh("file deleted", [NEW], [], deleted);
  }
  console.log("after: file created           ", fmt(created));
  console.log("after: file deleted           ", fmt(deleted));
} finally {
  await writeFile(join(root, BARREL), barrelText);
  await writeFile(join(root, BODY), bodyText);
  await rm(join(root, NEW), { force: true });
  worker.terminate();
}

// The worker's tree after every edit and revert must equal a fresh build.
const fresh = await buildFacetedPluginTree(pluginsRoot, {
  repo: await loadRepoSnapshot(root),
});
const a = JSON.stringify(pluginTreeToJson(fresh));
const b = JSON.stringify(pluginTreeToJson(tree));
console.log(
  a === b ? "equivalent to a fresh build" : "DIFFERS from a fresh build",
);
if (a !== b) {
  process.exitCode = 1;
  for (const [path, n] of fresh.byPath) {
    const m = tree.byPath.get(path);
    const x = JSON.stringify({
      ...n,
      dir: 0,
      children: n.children.map((c) => c.path),
    });
    const y =
      m &&
      JSON.stringify({ ...m, dir: 0, children: m.children.map((c) => c.path) });
    if (x === y) continue;
    console.log("node", path, m ? "" : "(missing)");
    if (!m) continue;
    for (const k of Object.keys(n.facets)) {
      const fx = JSON.stringify(n.facets[k]);
      const fy = JSON.stringify(m.facets[k]);
      if (fx !== fy)
        console.log(
          "  facet",
          k,
          fx.slice(0, 300),
          "\n   vs",
          fy?.slice(0, 300),
        );
    }
  }
  for (const path of tree.byPath.keys())
    if (!fresh.byPath.has(path)) console.log("extra node", path);
}
