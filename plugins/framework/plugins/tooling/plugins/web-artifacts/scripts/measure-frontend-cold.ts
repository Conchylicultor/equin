// The frontend pipeline alone, cold: `runWebArtifactsPipeline` over the
// committed full registry against an EMPTY throwaway data root (no artifact,
// vendor, package-asset or CSS store), so every artifact builds. Nothing else
// runs beside it — no codegen, no checks, no type-check competing for the
// cores, which is what made the hermetic build's cold frontend number noise
// (3a: 48–61 s, the spread all in `artifacts:build`). Prints each stage's wall
// time and the total; `--runs N` repeats it with a fresh data root each time.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-frontend-cold.ts [--runs 3] [--threads 4|auto] [--json out.json]
//
// Codegen must already be current (the committed registries and the browser
// host's generated entry list) — run it after a build or an install.
// Plan: research/2026-10-30-global-build-pipeline-step3b-batched-artifacts-and-repo-snapshot.md.

import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlatformApi } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import type { ArtifactBuilder } from "../core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const arg = (name: string, dflt: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : dflt;
};
const runs = Number(arg("runs", "1"));
// --threads N | auto: compile on the build's pooled builder (N worker threads;
// auto = the count `./equin build` picks); omitted: the pipeline's in-process
// default. The pooled builder loads only when asked, so the script also runs
// on a tree that predates it.
const threadsArg = arg("threads", "0");
const jsonOut = arg("json", "");

// The store's dirs freeze at first import (store.ts): one data root per
// process, so each run is its own child of this script.
if (process.env.BP_COLD_CHILD !== "1") {
  const results: unknown[] = [];
  for (let i = 1; i <= runs; i++) {
    const dataRoot = mkdtempSync(join(HOME_DIR, ".bp-cold-"));
    const out = join(dataRoot, "result.json");
    const proc = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
      env: {
        ...process.env,
        BP_COLD_CHILD: "1",
        ...envEntries({ DIR: dataRoot }),
        BP_OUT: out,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0)
      throw new Error(`cold run ${i} exited ${proc.exitCode}`);
    results.push(JSON.parse(await Bun.file(out).text()));
    rmSync(dataRoot, { recursive: true, force: true });
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  process.exit(0);
}

const { runWebArtifactsPipeline } = await import("../core/internal/pipeline");
const root = REPO_ROOT;
const stagingDir = asAppPath(mkdtempSync(join(HOME_DIR, ".bp-cold-staging-")));
const stages: Array<{ id: string; s: number }> = [];
const t0 = performance.now();
let threads = 0;
let builder: (ArtifactBuilder & { close(): Promise<void> }) | undefined;
if (threadsArg !== "0") {
  const { createPooledArtifactBuilder, idealArtifactBuildThreads } =
    await import("../cli");
  threads =
    threadsArg === "auto" ? idealArtifactBuildThreads() : Number(threadsArg);
  builder = createPooledArtifactBuilder({
    repoRoot: root,
    minify: true,
    threads,
  });
}
const result = await runWebArtifactsPipeline({
  builder,
  root,
  stagingDir,
  minify: true,
  buildId: "bp-cold",
  buildCommit: null,
  centralBuild: () => Promise.resolve(null),
  log: (line) => console.log(`  ${line}`),
  isPlatformApi,
  onStage: async (id, _label, run) => {
    const s0 = performance.now();
    try {
      return await run();
    } finally {
      stages.push({ id, s: (performance.now() - s0) / 1000 });
    }
  },
});
const total = (performance.now() - t0) / 1000;
await builder?.close();
console.log(
  `cold frontend: ${total.toFixed(2)} s (${result.builtArtifacts} built, ${threads > 0 ? `${threads} threads` : "in-process"})`,
);
for (const { id, s } of stages)
  console.log(`  ${id.padEnd(28)} ${s.toFixed(2)} s`);
rmSync(stagingDir, { recursive: true, force: true });
writeFileSync(
  process.env.BP_OUT!,
  JSON.stringify({ total, built: result.builtArtifacts, stages }),
);
