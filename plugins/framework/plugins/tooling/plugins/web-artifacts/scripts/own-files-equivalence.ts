// Step 3c's equivalence gate (research/2026-11-03-global-build-pipeline-step3c-repo-snapshot.md):
// what each address hashes and which plugins exist, read off the repo
// snapshot, against what the disk walks they replaced found. Prints every
// difference; the only expected ones are gitignored files.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/own-files-equivalence.ts

import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  readdirSync,
  existsSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, relative } from "node:path";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  hashedRootsFor,
  isHashedFile,
  listOwnFiles,
} from "../core/internal/own-files";

const root = REPO_ROOT;
const pluginsRoot = joinAppPath(root, "plugins");
const snapshot = await loadRepoSnapshot(root);

// The walk `listOwnFiles` used to do: every regular file under each root the
// skip rules keep, symlinks skipped, plus package.json when on disk.
function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}
function walkedOwnFiles(pluginDir: string, kind: string): string[] {
  const out: string[] = [];
  for (const r of hashedRootsFor(pluginDir, kind)) {
    const all: string[] = [];
    walk(r, all);
    for (const f of all) if (isHashedFile([r], f)) out.push(f);
  }
  if (kind !== "entry" && existsSync(join(pluginDir, "package.json"))) {
    out.push(join(pluginDir, "package.json"));
  }
  return out.sort();
}

const tree = await buildPluginTree(pluginsRoot, { repo: snapshot });
let compared = 0;
const diffs: string[] = [];
const KINDS = ["web", "core", "server", "machine", "central", "prewarm"];
for (const node of tree.byDir.values()) {
  for (const kind of KINDS) {
    if (!existsSync(join(node.dir, kind, "index.ts"))) continue;
    compared++;
    const walked = walkedOwnFiles(node.dir, kind);
    const listed = listOwnFiles(snapshot, node.dir, kind);
    const listedSet = new Set(listed);
    const walkedSet = new Set(walked);
    for (const f of walked)
      if (!listedSet.has(f))
        diffs.push(`only walked  ${node.path}|${kind}: ${relative(root, f)}`);
    for (const f of listed)
      if (!walkedSet.has(f))
        diffs.push(`only listed  ${node.path}|${kind}: ${relative(root, f)}`);
  }
}
const webCoreWeb = joinAppPath(root, "plugins/framework/plugins/web-core/web");
const entryWalked = walkedOwnFiles(webCoreWeb, "entry");
const entryListed = listOwnFiles(snapshot, webCoreWeb, "entry");
compared++;
for (const f of entryWalked)
  if (!entryListed.includes(f))
    diffs.push(`only walked  entry: ${relative(root, f)}`);

console.log(`${tree.byDir.size} plugins, ${compared} artifact roots compared`);
console.log(diffs.length === 0 ? "no difference" : diffs.join("\n"));
