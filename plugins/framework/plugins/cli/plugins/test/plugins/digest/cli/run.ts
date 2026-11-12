import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { repoSnapshotNow } from "@plugins/framework/plugins/tooling/core";
import { isTestFilePath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import { pluginIdOfRepoPath } from "@plugins/framework/plugins/plugin-id/core";
import type { CheckoutDigests } from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import {
  installRecordStore,
  currentRecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { TEST_DIGEST_VERSION, testDigests } from "../core";

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 30_000;

function writeAtomic(path: string, value: CheckoutDigests): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, path);
}

/**
 * Every test file of this checkout under `plugins/`, digested — written to
 * `--out` for the `tests.checkout-digests` job, which replaces the page's
 * checkout digests with them. `--unless-tree` names the tree the caller's
 * digests already describe: the same tree writes `unchanged` and digests
 * nothing.
 */
const run: CliAction<[], { out: string; unlessTree?: string }> = async (
  opts,
) => {
  const out = resolve(process.cwd(), opts.out);
  const root = await getWorktreeRoot();
  const started = performance.now();
  const treeHash = await computeTreeHash(root);
  if (treeHash === null)
    throw new Error("test-digest: this checkout's tree hash is unavailable");
  if (opts.unlessTree === treeHash) {
    writeAtomic(out, { kind: "unchanged", treeHash });
    console.log(`test-digest: tree ${treeHash.slice(0, 12)} unchanged`);
    return;
  }
  const rev = await spawnCaptured(["git", "rev-parse", "HEAD"], {
    cwd: root,
    env: process.env,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const head = rev.exitCode === 0 ? rev.stdout.trim() : null;
  installRecordStore(openRecordStore());
  const store = currentRecordStore();
  const snapshot = await repoSnapshotNow(root);
  const files = snapshot
    .under("plugins")
    .filter((p) => isTestFilePath(p) && !p.split("/").includes("node_modules"));
  const digests = await testDigests(snapshot, store, files);
  store.flush();
  const elapsedMs = Math.round(performance.now() - started);
  writeAtomic(out, {
    kind: "digests",
    treeHash,
    head,
    digestVersion: TEST_DIGEST_VERSION,
    computedAt: new Date().toISOString(),
    elapsedMs,
    files: [...digests].map(([path, d]) => ({
      path,
      runner: d.runner,
      digest: d.digest,
      pluginId: pluginIdOfRepoPath(path),
    })),
  });
  console.log(
    `test-digest: ${files.length} test files digested in ${elapsedMs} ms (tree ${treeHash.slice(0, 12)})`,
  );
};

export default run;
