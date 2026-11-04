// Where one cold artifact build spends its time: vite/Rolldown setup per run,
// the Babel pass (@vitejs/plugin-react + the React Compiler), the bundle, or
// the builder's post-build steps (audits, emitted-import parse, sourcemap
// check, Tailwind candidates, publish + precompress). Builds a stride sample of
// the fleet's real web targets four ways, against a throwaway data root so no
// store is touched:
//
//   full     buildArtifact() per target (everything, published to the temp store)
//   single   a bare vite build per target (same plugins, no write, no post-steps)
//   bare     the same, without the React plugin (no Babel)
//   batch    ONE vite build of every sampled target as entries (with React), and
//            the same without React
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-artifact-build.ts [--n 60] [--kind web]
//
// Plan: research/2026-10-30-global-build-pipeline-step3b-batched-artifacts-and-repo-snapshot.md (Phase 0).

import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The store's dirs freeze at first import (store.ts): point the data root at a
// throwaway dir BEFORE any web-artifacts module loads (they load below, by
// relative dynamic import).
const dataRoot = mkdtempSync(join(HOME_DIR, ".bp-measure-"));
setEnv("DIR", dataRoot);

const arg = (name: string, dflt: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : dflt;
};
const n = Number(arg("n", "60"));
const kind = arg("kind", "web");
const only = arg("only", "");

const root = REPO_ROOT;
const pluginsRoot = joinAppPath(root, "plugins");

const { planFleet } = await import("../core/internal/plan");
const { loadGlobPatternMemo } = await import("../core/internal/store");
const { buildArtifact } = await import("../core/internal/vite-builder");
const { makeArtifactExternal } = await import("../core/externals");
const { build: viteBuild } = await import("vite");
const { default: react } = await import("@vitejs/plugin-react");

const fleet = await planFleet({
  root,
  minify: true,
  sources: {
    snapshot: await loadRepoSnapshot(root),
    globs: loadGlobPatternMemo(),
  },
});
const pool = fleet.webTargets.filter(
  (t) => t.kind === kind && t.coEntries.length === 0,
);
const stride = Math.max(1, Math.floor(pool.length / n));
const sample = pool.filter((_, i) => i % stride === 0).slice(0, n);
const babelContributions = await loadBabelContributions({
  pluginsRoot,
  repoRoot: root,
});
console.log(
  `${sample.length} ${kind} targets sampled from ${pool.length} (data root ${dataRoot})`,
);

const define = { "process.env.NODE_ENV": JSON.stringify("production") };
const bare = async (
  input: Record<string, string>,
  external: (id: string) => boolean,
  withReact: boolean,
) =>
  viteBuild({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: withReact
      ? [react({ babel: { plugins: babelContributions.map((c) => c.plugin) } })]
      : [],
    define,
    resolve: { alias: { "@plugins": pluginsRoot } },
    base: "./",
    build: {
      write: false,
      minify: "oxc",
      sourcemap: true,
      cssCodeSplit: true,
      reportCompressedSize: false,
      rolldownOptions: {
        input,
        external,
        preserveEntrySignatures: "strict",
        output: { format: "es", entryFileNames: "[name]/index.js" },
      },
    },
  });

const time = async (label: string, run: () => Promise<unknown>) => {
  const t0 = performance.now();
  await run();
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(28)} ${(ms / 1000).toFixed(2)} s  (${(ms / sample.length).toFixed(1)} ms/target)`,
  );
  return ms;
};

// Warm the toolchain once (module eval, native bindings) so no row pays it.
await bare({ w: sample[0]!.entryFile }, () => true, true);

const ctx = { repoRoot: root, pluginsRoot, babelContributions, minify: true };
if (only !== "single")
  await time("full (buildArtifact)", async () => {
    for (const t of sample) await buildArtifact(t, ctx);
  });
if (only === "full") {
  rmSync(dataRoot, { recursive: true, force: true });
  process.exit(0);
}
const perTarget: Array<{ name: string; ms: number }> = [];
await time("single, React", async () => {
  for (const t of sample) {
    const t0 = performance.now();
    await bare(
      { [t.dirName]: t.entryFile },
      makeArtifactExternal(t.pluginPath, t.kind),
      true,
    );
    perTarget.push({ name: t.dirName, ms: performance.now() - t0 });
  }
});
// The tail: a few large artifacts bound any split of the work.
perTarget.sort((a, b) => b.ms - a.ms);
const totalMs = perTarget.reduce((n, t) => n + t.ms, 0);
console.log(
  `  slowest 10 of ${perTarget.length} (${((perTarget.slice(0, 10).reduce((n, t) => n + t.ms, 0) / totalMs) * 100).toFixed(0)}% of the row):`,
);
for (const t of perTarget.slice(0, 10))
  console.log(`    ${t.ms.toFixed(0).padStart(6)} ms  ${t.name}`);
await time("single, no React", async () => {
  for (const t of sample)
    await bare(
      { [t.dirName]: t.entryFile },
      makeArtifactExternal(t.pluginPath, t.kind),
      false,
    );
});
if (only === "single") {
  rmSync(dataRoot, { recursive: true, force: true });
  process.exit(0);
}
// Batched: one plugin's own files are never another's, and every @plugins
// spec of another plugin is external — the union external is "any bare spec".
const input = Object.fromEntries(sample.map((t) => [t.dirName, t.entryFile]));
const externalAny = (id: string) =>
  !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0");
await time("batch, React", () => bare(input, externalAny, true));
await time("batch, no React", () => bare(input, externalAny, false));

rmSync(dataRoot, { recursive: true, force: true });
