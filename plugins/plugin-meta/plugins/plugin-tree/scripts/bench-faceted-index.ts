// Faceted tree, cold and per edit. Before: every file event under `plugins/`
// spawned `./equin plugin-tree-facets`, which built the whole tree again — a
// whole snapshot, the structure, every plugin's record keys and reads, relate,
// a 7.8 MB JSON round trip — on top of its own process boot and tooling load.
// "before" measures that in-process work (records warm), a floor of what the
// child cost. After: the faceted-tree worker's cold build once, then its
// refreshes — and its tree after every edit equals a fresh build.
// Then across processes: a new worker started from the checkpoint the last
// one left, after edits made while none ran (the journal names them), against
// one started cold — and its tree too must equal a fresh build.
// Then git moving the checkout while none ran — a branch switch, a rebase —
// and journal gaps, in a throwaway checkout (`--skip-git` to skip).
// `./equin run plugins/plugin-meta/plugins/plugin-tree/scripts/bench-faceted-index.ts [--rounds N] [--skip-old] [--skip-git]`
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile, realpath } from "@plugins/packages/plugins/timed-fs/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import {
  pluginTreeFromDelta,
  pluginTreeToJson,
  type FacetedStart,
  type PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { FromWorkerFrame, ToWorkerFrame } from "../shared/protocol";

const argv = process.argv.slice(2);
const ROUNDS = Number(argv[argv.indexOf("--rounds") + 1] || 3);
const SKIP_OLD = argv.includes("--skip-old");
const SKIP_GIT = argv.includes("--skip-git");
// Reassigned for the git moves (a throwaway checkout), at the end.
let root = await getWorktreeRoot();
let pluginsRoot = joinAppPath(root, "plugins");
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

const scratch = await mkdtemp(join(tmpdir(), "bench-faceted-index-"));
const checkpointFile = join(scratch, "faceted-index.json");

let worker!: Worker;
let frames: FromWorkerFrame[] = [];
/** The structure as the worker last posted it, and when it first did. */
let structure: PluginTreeData | null = null;
let structureAt = 0;
/** How the last worker started. */
let lastStart: FacetedStart | null = null;
let wake: (() => void) | null = null;
async function next(): Promise<FromWorkerFrame> {
  while (frames.length === 0) await new Promise<void>((r) => (wake = r));
  const f = frames.shift()!;
  if (f.type === "failed") throw new Error(f.message);
  return f;
}
const send = (f: ToWorkerFrame) => worker.postMessage(f);

/** A new worker, built (from the checkpoint when it can); its tree. */
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
  send({ type: "init", root, checkpointFile });
  const ready = await next();
  if (ready.type !== "ready") throw new Error("expected ready");
  if (ready.facets.kind === "failed")
    throw new Error(`${label}: facets failed: ${ready.facets.message}`);
  const built = pluginTreeFromDelta(pluginsRoot, ready.facets.delta, null);
  lastStart = ready.start;
  assertStructureOf(built, label);
  console.log(
    `after: ${label.padEnd(22)} ${(performance.now() - s).toFixed(0)} ms (in worker ${ready.ms.toFixed(0)} ms; structure at ${(structureAt - s).toFixed(0)} ms), ${
      ready.start.kind === "resumed"
        ? `resumed, ${ready.start.changed} paths changed`
        : `cold: ${ready.start.reason}`
    }\n    steps: ${Object.entries(ready.steps)
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

/** Stop the worker once its checkpoint is written (the frame after init). */
async function stop(): Promise<void> {
  send({ type: "refresh", id: -1, paths: [], edited: [] });
  await next();
  worker.terminate();
}

await rm(checkpointFile, { force: true });
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

// Across processes: edits while no worker runs, then one started from the
// checkpoint, against one started cold.
await stop();
await writeFile(
  join(root, BARREL),
  `${barrelText}\nexport type BenchProbe = 1;\n`,
);
await writeFile(join(root, NEW), "export const benchProbe = 1;\n");
try {
  for (let i = 0; i < ROUNDS; i++) {
    tree = await start("from the checkpoint");
    await stop();
  }
  await compare("the resumed worker's", tree);
  for (let i = 0; i < ROUNDS; i++) {
    await rm(checkpointFile, { force: true });
    tree = await start("cold");
    await stop();
  }
} finally {
  await writeFile(join(root, BARREL), barrelText);
  await rm(join(root, NEW), { force: true });
}

// Git moving the checkout while no worker runs, in a throwaway clone of this
// repo (`--shared`: its objects borrowed, no worktree registered; never this
// checkout, whose edits are uncommitted), detached: a branch
// switch and a rebase, each resumed from the checkpoint and compared with a
// fresh build; then journal gaps — a cursor past the journal's age bound, and
// a journal whose ids went back — which must start cold, saying why.
if (!SKIP_GIT) {
  const own = root;
  const at = (n: number) => git(own, ["rev-parse", `HEAD~${n}`]);
  const [base, switched, onto, upstream] = await Promise.all([
    at(3),
    at(10),
    at(13),
    at(11),
  ]);
  const wt = join(await realpath(scratch), "checkout");
  await git(own, ["clone", "--quiet", "--shared", "--no-checkout", own, wt]);
  await git(wt, ["checkout", "--quiet", "--detach", base]);
  // Facets resolve packages (tailwindcss) from the checkout: lend it ours,
  // every workspace's — links, which `.gitignore`'s folder-only
  // `node_modules/` does not match, so excluded by name.
  await writeFile(join(wt, ".git/info/exclude"), "node_modules\n");
  const installs = await spawnExpectOk(
    ["fd", "-HI", "-t", "d", "--prune", "^node_modules$", "."],
    { cwd: own, timeoutMs: 120_000 },
  );
  for (const dir of installs.stdout.split("\n").filter(Boolean)) {
    const rel = dir.replace(/^\.\//, "").replace(/\/$/, "");
    await symlink(join(own, rel), join(wt, rel)).catch((err: unknown) => {
      // A workspace the older commit does not have yet: nothing to lend.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    });
  }
  try {
    root = wt as typeof root;
    pluginsRoot = joinAppPath(root, "plugins");
    await rm(checkpointFile, { force: true });
    tree = await start("git: cold build");
    await stop();
    await git(wt, ["checkout", "--quiet", "--detach", switched]);
    tree = await start("git: branch switched");
    await stop();
    expectStart("branch switch", "resumed");
    await compare("after a branch switch, the resumed worker's", tree);
    // Replays the commits after `upstream` (HEAD~11..HEAD~10) onto HEAD~13.
    await git(wt, [
      "-c",
      "user.name=bench",
      "-c",
      "user.email=bench@localhost",
      "rebase",
      "--onto",
      onto,
      upstream,
    ]);
    tree = await start("git: rebased");
    await stop();
    expectStart("rebase", "resumed");
    await compare("after a rebase, the resumed worker's", tree);
    for (const [label, gap, reason] of [
      [
        "cursor past the journal's age",
        (c: CheckpointJson) => {
          c.cursor.takenAt -= 8 * 24 * 60 * 60 * 1000;
        },
        "too old",
      ],
      [
        "journal reset",
        (c: CheckpointJson) => {
          c.cursor.eventId = String(BigInt(c.cursor.eventId) * 2n);
        },
        "reset",
      ],
    ] as const) {
      const saved = JSON.parse(
        await readFile(checkpointFile, "utf8"),
      ) as CheckpointJson;
      gap(saved);
      await writeFile(checkpointFile, JSON.stringify(saved));
      tree = await start(`git: ${label}`);
      await stop();
      expectStart(label, "cold", reason);
      await compare(`after a gap (${label}), the worker's`, tree);
    }
  } finally {
    root = own;
    pluginsRoot = joinAppPath(root, "plugins");
    await rm(wt, { recursive: true, force: true });
  }
}
await rm(scratch, { recursive: true, force: true });

/** The fields of the checkpoint file a journal gap is made in. */
interface CheckpointJson {
  cursor: { takenAt: number; eventId: string };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await spawnExpectOk(["git", ...args], {
    cwd,
    timeoutMs: 120_000,
  });
  return stdout.trim();
}

/** How the last start began must be `kind` (its reason holding `reason`). */
function expectStart(
  label: string,
  kind: "resumed" | "cold",
  reason?: string,
): void {
  const ok =
    lastStart?.kind === kind &&
    (reason === undefined ||
      (lastStart.kind === "cold" && lastStart.reason.includes(reason)));
  console.log(
    `${label}: started ${lastStart?.kind === "cold" ? `cold (${lastStart.reason})` : lastStart?.kind} — ${ok ? "as expected" : `EXPECTED ${kind}${reason ? ` (${reason})` : ""}`}`,
  );
  if (!ok) process.exitCode = 1;
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
