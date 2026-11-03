// The worker half of spike-build-threads.ts: load the toolchain, build its
// chunk of targets as ONE batched vite run (write:false), report the times.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { loadBabelContributions } from "@plugins/framework/plugins/web-core/core";

// Thread mode: workerData; process mode (no parentPort): a JSON file in argv.
const input = parentPort
  ? workerData
  : JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const { root, chunk, filter } = input as {
  root: string;
  chunk: Array<{ name: string; entry: string }>;
  filter: boolean;
};
const pluginsRoot = join(root, "plugins");

const t0 = performance.now();
const { build } = await import("vite");
const { default: react } = await import("@vitejs/plugin-react");
const babelPlugins = (
  await loadBabelContributions({ pluginsRoot, repoRoot: root })
).map((c) => c.plugin);
const loadMs = performance.now() - t0;

// A `.ts` file with no `use[A-Z0-9]` token defines no hook, and (no JSX) no
// component: the React Compiler would leave it as is.
const HOOK_TOKEN = /\buse[A-Z0-9]/;
const needsBabel = (id: string) => {
  const file = id.split("?")[0]!;
  if (!file.endsWith(".ts")) return true;
  return HOOK_TOKEN.test(readFileSync(file, "utf8"));
};

const t1 = performance.now();
await build({
  configFile: false,
  logLevel: "silent",
  root,
  plugins: [
    react({
      babel: filter
        ? (id: string) => ({ plugins: needsBabel(id) ? babelPlugins : [] })
        : { plugins: babelPlugins },
    }),
  ],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { "@plugins": pluginsRoot } },
  base: "./",
  build: {
    write: false,
    minify: "oxc",
    sourcemap: true,
    cssCodeSplit: true,
    reportCompressedSize: false,
    rolldownOptions: {
      input: Object.fromEntries(chunk.map((t) => [t.name, t.entry])),
      external: (id: string) =>
        !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
      preserveEntrySignatures: "strict",
      output: { format: "es", entryFileNames: "[name]/index.js" },
    },
  },
});
const reply = { loadMs, buildMs: performance.now() - t1 };
if (parentPort) parentPort.postMessage(reply);
else console.log(`RESULT ${JSON.stringify(reply)}`);
