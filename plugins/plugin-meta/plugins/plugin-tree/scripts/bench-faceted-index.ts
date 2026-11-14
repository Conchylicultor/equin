// Faceted tree, cold and per edit. Before: every file event under `plugins/`
// spawned `./equin plugin-tree-facets`, which built the whole tree again — a
// whole snapshot, the structure, every plugin's record keys and reads, relate,
// a 7.8 MB JSON round trip — on top of its own process boot and tooling load.
// "before" measures that in-process work (records warm), a floor of what the
// child cost. After: the faceted-tree worker's cold build once, then its
// refreshes — and its tree after every edit equals a fresh build.
// Then across processes: a new worker, as each backend restart starts one,
// after edits made while none ran — its tree too must equal a fresh build.
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
    await store.flush();
    old.push(performance.now() - s);
  }
  console.log("before: per change, in-process ", fmt(old));
}

let worker!: Worker;
let frames: FromWorkerFrame[] = [];
/** The structure as the worker last posted it, and when it first did. */
let structure: PluginTreeData | null = null;
let structureAt = 0;
let wake: (() => void) | null = null;
async function next(): Promise<FromWorkerFrame> {
  while (frames.length === 0) await new Promise<void>((r) => (wake = r));
  const f = frames.shift()!;
  if (f.type === "failed") throw new Error(f.message);
  return f;
}
const send = (f: ToWorkerFrame) => worker.postMessage(f);

/** A new worker, built; its tree. */
async function start(label: string): Promise<PluginTreeData> {
  frames = [];
  worker = new Worker(
    new URL("../bin/faceted-tree-worker.ts", import.meta.url),
  );
  structure = null;
  worker.onmessage = (e: MessageEvent<FromWorkerFrame>) => {
    if (e.data.type === "structure") {
      if (structure === null) structureAt = performance.now();
      structure = pluginTreeFromDelta(pluginsRoot, e.data.delta, null);
      return;
    }
    frames.push(e.data);
    wake?.();
  };
  const s = performance.now();
  send({ type: "init", root });
  const ready = await next();
  if (ready.type !== "ready") throw new Error("expected ready");
  if (ready.facets.kind === "failed")
    throw new Error(`${label}: facets failed: ${ready.facets.message}`);
  const built = pluginTreeFromDelta(pluginsRoot, ready.facets.delta, null);
  assertStructureOf(built, label);
  console.log(
    `after: ${label.padEnd(22)} ${(performance.now() - s).toFixed(0)} ms (in worker ${ready.ms.toFixed(0)} ms; structure at ${(structureAt - s).toFixed(0)} ms)\n    steps: ${Object.entries(
      ready.steps,
    )
      .map(([step, ms]) => `${step} ${ms}`)
      .join(", ")}`,
  );
  return built;
}

/** The structure the worker posted equals `tree`'s, facets aside. */
function assertStructureOf(tree: PluginTreeData, label: string): void {
  const bare = (t: PluginTreeData) =>
    JSON.stringify(pluginTreeToJson(t), (k, v: unknown) =>
      k === "facets" ? {} : v,
    );
  if (structure === null || bare(structure) !== bare(tree))
    throw new Error(`${label}: the posted structure differs from the tree's`);
}

/** Stop the worker once its queue is drained (the frame after init). */
async function stop(): Promise<void> {
  send({ type: "refresh", id: -1, paths: [], edited: [] });
  await next();
  worker.terminate();
}

let tree: PluginTreeData = await start("cold build");
console.log(`  ${tree.byPath.size} nodes`);

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
  if (f.result.kind === "facets-failed")
    throw new Error(`facets failed: ${f.result.message}`);
  if (f.result.kind === "facets-retry")
    throw new Error("facets retried in a fresh worker");
  if (f.result.kind === "changed")
    tree = pluginTreeFromDelta(pluginsRoot, f.result.delta, tree);
  assertStructureOf(tree, label);
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
}
await compare("the worker's after its edits", tree);

// Across processes: edits while no worker runs, then a new worker — what
// every backend restart pays.
await stop();
await writeFile(
  join(root, BARREL),
  `${barrelText}\nexport type BenchProbe = 1;\n`,
);
await writeFile(join(root, NEW), "export const benchProbe = 1;\n");
try {
  for (let i = 0; i < ROUNDS; i++) {
    tree = await start("restarted worker");
    await stop();
  }
  await compare("the restarted worker's", tree);
} finally {
  await writeFile(join(root, BARREL), barrelText);
  await rm(join(root, NEW), { force: true });
}

/** `tree` must equal a fresh build of the checkout as it is now. */
async function compare(label: string, tree: PluginTreeData): Promise<void> {
  const fresh = await buildFacetedPluginTree(pluginsRoot, {
    repo: await loadRepoSnapshot(root),
  });
  const a = JSON.stringify(pluginTreeToJson(fresh));
  const b = JSON.stringify(pluginTreeToJson(tree));
  console.log(
    `${label} tree: ${a === b ? "equivalent to a fresh build" : "DIFFERS from a fresh build"}`,
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
        JSON.stringify({
          ...m,
          dir: 0,
          children: m.children.map((c) => c.path),
        });
      if (x === y) continue;
      console.log("node", path, m ? "" : "(missing)");
      if (!m) continue;
      /** Where two texts first part, and a window around it in each. */
      const at = (fx: string, fy: string): string => {
        let i = 0;
        while (i < fx.length && fx[i] === fy[i]) i++;
        const from = Math.max(0, i - 120);
        return `at ${i}: fresh …${fx.slice(from, i + 200)}\n   resumed …${fy.slice(from, i + 200)}`;
      };
      for (const k of Object.keys({ ...n, ...m }) as (keyof typeof n)[]) {
        if (k === "facets" || k === "dir" || k === "children") continue;
        const fx = JSON.stringify(n[k]);
        const fy = JSON.stringify(m[k]);
        if (fx !== fy) console.log("  field", k, at(fx, fy ?? ""));
      }
      const kids = (t: typeof n) =>
        JSON.stringify(t.children.map((c) => c.path));
      if (kids(n) !== kids(m)) console.log("  children", at(kids(n), kids(m)));
      for (const k of Object.keys({ ...n.facets, ...m.facets })) {
        const fx = JSON.stringify(n.facets[k]) ?? "";
        const fy = JSON.stringify(m.facets[k]) ?? "";
        if (fx !== fy) console.log("  facet", k, at(fx, fy));
      }
    }
    for (const path of tree.byPath.keys())
      if (!fresh.byPath.has(path)) console.log("extra node", path);
  }
}
