// Spike: do batched artifact builds scale across worker threads? Babel (the
// React Compiler) is JS on the main thread, so the pipeline's concurrent vite
// runs all share ONE thread today. Builds a stride sample of real web targets
// as batched (multi-entry) vite runs split over K worker threads, write:false,
// and reports the wall time per K. `--filter` skips Babel for `.ts` files that
// cannot hold a component or hook (no `use[A-Z0-9]` token).
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/spike-build-threads.ts [--n 240] [--threads 1,3,6] [--filter]
//
// Plan: research/2026-10-30-global-build-pipeline-step3b-batched-artifacts-and-repo-snapshot.md (Phase 0).

import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { planFleet } from "../core/internal/plan";
import { loadGlobPatternMemo } from "../core/internal/store";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const arg = (name: string, dflt: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : dflt;
};
const n = Number(arg("n", "240"));
const threadCounts = arg("threads", "1,3,6").split(",").map(Number);
const filter = process.argv.includes("--filter");
// --processes: each chunk in its own bun process instead of a worker thread.
const processes = process.argv.includes("--processes");
const root = asAppPath(join(import.meta.dir, "../../../../../../.."));

const fleet = await planFleet({
  root,
  minify: true,
  sources: {
    snapshot: await loadRepoSnapshot(root),
    globs: loadGlobPatternMemo(),
  },
});
const pool = fleet.webTargets.filter((t) => t.coEntries.length === 0);
const stride = Math.max(1, Math.floor(pool.length / n));
const sample = pool
  .filter((_, i) => i % stride === 0)
  .slice(0, n)
  .map((t) => ({ name: t.dirName, entry: t.entryFile }));
console.log(`${sample.length} web targets of ${pool.length}, filter=${filter}`);

const runWith = async (k: number) => {
  const chunks: (typeof sample)[] = Array.from({ length: k }, () => []);
  sample.forEach((t, i) => chunks[i % k]!.push(t));
  const t0 = performance.now();
  const results = await Promise.all(
    chunks.map((chunk) =>
      processes
        ? (async () => {
            const dir = mkdtempSync(join(os.tmpdir(), "bp-spike-"));
            const file = join(dir, "input.json");
            writeFileSync(file, JSON.stringify({ root, chunk, filter }));
            const r = await spawnCaptured(
              [
                process.execPath,
                join(import.meta.dir, "spike-build-thread.ts"),
                file,
              ],
              { cwd: root, timeoutMs: 600_000 },
            );
            const line = r.stdout
              .split("\n")
              .find((l) => l.startsWith("RESULT "));
            if (!line) throw new Error(`spike child failed: ${r.stderr}`);
            return JSON.parse(line.slice(7)) as {
              loadMs: number;
              buildMs: number;
            };
          })()
        : new Promise<{ loadMs: number; buildMs: number }>(
            (resolve, reject) => {
              const w = new Worker(
                join(import.meta.dir, "spike-build-thread.ts"),
                {
                  workerData: { root, chunk, filter },
                },
              );
              w.once("message", resolve);
              w.once("error", reject);
            },
          ),
    ),
  );
  const wall = performance.now() - t0;
  const load = Math.max(...results.map((r) => r.loadMs));
  const build = Math.max(...results.map((r) => r.buildMs));
  console.log(
    `${processes ? "processes" : "threads"}=${k}: wall ${(wall / 1000).toFixed(2)} s (slowest thread: toolchain load ${(load / 1000).toFixed(2)} s, build ${(build / 1000).toFixed(2)} s)`,
  );
};

for (const k of threadCounts) await runWith(k);
