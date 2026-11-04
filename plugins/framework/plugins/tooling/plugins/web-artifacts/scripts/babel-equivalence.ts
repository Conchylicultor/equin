// Proves the builder's own Babel pass (`core/internal/babel-transform.ts`)
// emits what `@vitejs/plugin-react` did: builds a stride sample of real
// artifacts both ways (write:false, the builder's minify and define) and
// compares every emitted chunk's code byte for byte. plugin-react runs every
// contribution on every module; the new pass skips modules no contribution
// applies to — so equal bytes also prove each `appliesTo` false is exact.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/babel-equivalence.ts [--n 120]

import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

import type { Rolldown } from "vite";
import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";
import { makeArtifactExternal } from "../core/externals";
import { babelContributionsPlugin } from "../core/internal/babel-transform";
import { planFleet } from "../core/internal/plan";
import { loadGlobPatternMemo } from "../core/internal/store";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const at = process.argv.indexOf("--n");
const n = at > 0 ? Number(process.argv[at + 1]) : 120;
const root = REPO_ROOT;
const pluginsRoot = joinAppPath(root, "plugins");

const fleet = await planFleet({
  root,
  minify: true,
  sources: {
    snapshot: await loadRepoSnapshot(root),
    globs: loadGlobPatternMemo(),
  },
});
const pool = fleet.webTargets;
const stride = Math.max(1, Math.floor(pool.length / n));
const sample = pool.filter((_, i) => i % stride === 0).slice(0, n);
const contributions = await loadBabelContributions({
  pluginsRoot,
  repoRoot: root,
});
const { build } = await import("vite");
const { default: react } = await import("@vitejs/plugin-react");

const emit = async (
  t: (typeof sample)[number],
  plugin: unknown,
): Promise<Map<string, string>> => {
  const out = (await build({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: [plugin as never],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: { "@plugins": pluginsRoot } },
    base: "./",
    build: {
      write: false,
      minify: "oxc",
      sourcemap: false,
      cssCodeSplit: true,
      reportCompressedSize: false,
      lib: {
        entry: {
          index: t.entryFile,
          ...Object.fromEntries(
            t.coEntries.map((e) => [e.folder, e.entryFile]),
          ),
        },
        formats: ["es"],
        fileName: (_f: string, name: string) => `${name}.js`,
      },
      rolldownOptions: { external: makeArtifactExternal(t.pluginPath, t.kind) },
    },
  })) as Rolldown.RolldownOutput[] | Rolldown.RolldownOutput;
  const outputs = Array.isArray(out)
    ? out.flatMap((o) => o.output)
    : out.output;
  return new Map(
    outputs.map((f) => [
      f.fileName,
      f.type === "chunk" ? f.code : String(f.source),
    ]),
  );
};

let differing = 0;
for (const t of sample) {
  const before = await emit(
    t,
    react({ babel: { plugins: contributions.map((c) => c.plugin) } }),
  );
  const after = await emit(t, babelContributionsPlugin(contributions));
  const names = new Set([...before.keys(), ...after.keys()]);
  const diff = [...names].filter((f) => before.get(f) !== after.get(f));
  if (diff.length > 0) {
    differing++;
    console.log(`DIFF ${t.dirName}: ${diff.join(", ")}`);
  }
}
console.log(
  `${sample.length} artifacts compared, ${differing} differ (${sample.length - differing} byte-identical)`,
);
if (differing > 0) process.exit(1);
