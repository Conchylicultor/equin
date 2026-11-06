// Structure tree, cold and per edit: the whole-repo rebuild every watcher batch
// used to cost, against the structure index's cold build and its refreshes.
// `./equin run plugins/plugin-meta/plugins/plugin-tree/scripts/bench-structure-tree.ts`
import { relative } from "node:path";
import {
  buildPluginTree,
  createStructureIndex,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  listRepoMembers,
  loadRepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { appPathParent } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";

const ROOT = appPathParent(PLUGINS_DIR);
const REL = relative(ROOT, PLUGINS_DIR);
const ROUNDS = 5;

async function time<T>(f: () => Promise<T>): Promise<[T, number]> {
  const s = performance.now();
  const r = await f();
  return [r, performance.now() - s];
}
const fmt = (ms: number[]) =>
  ms.map((m) => m.toFixed(0).padStart(6)).join(" ") + " ms";

const gate = createSemaphore(8);
const io = {
  membersIn: (paths: readonly string[]) => listRepoMembers(ROOT, paths),
  read: (path: string) => gate.run(() => readFile(`${ROOT}/${path}`, "utf8")),
};

const old: number[] = [];
const oldList: number[] = [];
const cold: number[] = [];
const coldList: number[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const [repo, l] = await time(() =>
    loadRepoFiles(ROOT, { readConcurrency: 8 }),
  );
  const [, b] = await time(() => buildPluginTree(PLUGINS_DIR, { repo }));
  oldList.push(l);
  old.push(l + b);
  const [, l2] = await time(() => listRepoMembers(ROOT, [REL]));
  coldList.push(l2);
  const [, c] = await time(() => createStructureIndex(ROOT, REL, io));
  cold.push(c);
}
console.log("before: per change (= cold)   ", fmt(old));
console.log("  of which whole-repo listing ", fmt(oldList));
console.log("after: cold build             ", fmt(cold));
console.log("  of which plugins/ listing   ", fmt(coldList));

const index = await createStructureIndex(ROOT, REL, io);
console.log("nodes:", index.tree().byPath.size);
const SOURCE = `${REL}/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`;
const BARREL = `${REL}/plugin-meta/plugins/plugin-tree/server/index.ts`;
// [paths, edited]: a watcher `update` is `edited`, a create / delete `paths`.
const cases: Record<string, [string[], string[]]> = {
  "source file saved": [[], [SOURCE]],
  "barrel saved": [[], [BARREL]],
  "source file created/deleted": [[SOURCE], []],
  "plugin folder created/deleted": [
    [`${REL}/plugin-meta/plugins/plugin-tree`],
    [],
  ],
  "umbrella folder (apps) moved": [[`${REL}/apps`], []],
};
for (const [name, [paths, edited]] of Object.entries(cases)) {
  const ms: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const [, t] = await time(() => index.refresh(paths, edited));
    ms.push(t);
  }
  console.log(`after: refresh, ${name}`.padEnd(45), fmt(ms));
}
