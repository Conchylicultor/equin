/**
 * What the test digest costs, split by phase: open the shared record store,
 * take the checkout snapshot, digest the test files under a path (default
 * every one), twice — cold for this process, then warm.
 *
 *   ./equin run plugins/framework/plugins/cli/plugins/test/plugins/digest/scripts/measure-digest.ts [dir]
 */
import { repoSnapshotNow } from "@plugins/framework/plugins/tooling/core";
import { isTestFilePath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { testDigests } from "../core";

const dir = process.argv[2] ?? "plugins";
const root = await getWorktreeRoot();
const ms = (t: number): string => `${Math.round(performance.now() - t)} ms`;

let t = performance.now();
const store = openRecordStore();
console.log(`open record store: ${ms(t)}`);
t = performance.now();
const snapshot = await repoSnapshotNow(root);
console.log(`snapshot: ${ms(t)} (${snapshot.all().length} files)`);
const files = snapshot
  .under(dir)
  .filter((p) => isTestFilePath(p) && !p.split("/").includes("node_modules"));
t = performance.now();
await testDigests(snapshot, store, files);
console.log(`digest ${files.length} files (first graph in process): ${ms(t)}`);
t = performance.now();
const snapshot2 = await repoSnapshotNow(root);
const t2 = performance.now();
await testDigests(snapshot2, store, files);
console.log(
  `again on a new snapshot: snapshot ${Math.round(t2 - t)} ms, digest ${ms(t2)}`,
);
store.flush();
