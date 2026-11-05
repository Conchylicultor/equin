/**
 * How wide each record producer's code identity is: the static+dynamic module
 * closure whose Merkle key keys its records, and how many of the last N main
 * commits touched it (each one re-keys every record that producer made).
 *
 *   ./equin run plugins/plugin-meta/plugins/plugin-records/scripts/key-closures.ts [--commits 200] <module>...
 */
import { spawnSync } from "child_process";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildModuleGraph, createMemoryRecordStore } from "../core";

const argv = process.argv.slice(2);
let commits = 200;
const modules: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--commits") commits = Number(argv[++i]);
  else modules.push(argv[i]!);
}
const root = asAppPath(process.cwd());
const snapshot = await loadRepoSnapshot(root);
const graph = await buildModuleGraph(
  { snapshot, store: createMemoryRecordStore(), readOutside: () => null },
  modules,
);

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const m = stack.pop()!;
    if (seen.has(m)) continue;
    seen.add(m);
    const n = graph.modules.get(m);
    if (!n) continue;
    stack.push(...n.staticDeps, ...n.dynamicDeps);
  }
  return seen;
}

const log = spawnSync(
  "git",
  [
    "log",
    `-${commits}`,
    "--first-parent",
    "--name-only",
    "--format=@%h",
    "origin/main",
  ],
  { encoding: "utf8", maxBuffer: 1 << 28 },
).stdout;
const touched: Set<string>[] = [];
for (const line of log.split("\n")) {
  if (line.startsWith("@")) touched.push(new Set());
  else if (line) touched.at(-1)!.add(line);
}

for (const m of modules) {
  const c = closure(m);
  const hits = touched.filter((t) => [...t].some((f) => c.has(f))).length;
  const plugins = new Map<string, number>();
  for (const f of c) {
    const top = f.split("/").slice(0, 2).join("/");
    plugins.set(top, (plugins.get(top) ?? 0) + 1);
  }
  console.log(
    `${m}\n  closure ${c.size} modules; re-keyed by ${hits}/${touched.length} main commits`,
  );
  console.log(
    `  top: ${[...plugins]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p, n]) => `${p}=${n}`)
      .join(" ")}`,
  );
}
