// Spike: can ONE Rolldown run build many server barrels as separate,
// independent outputs? Every bare specifier (`@plugins/*`, npm) is external,
// so the entries share no repo module. What is checked: whether any output
// imports a chunk shared with another entry (Rolldown's runtime helpers
// included). Times the run against building the same entries one by one.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/spike-multi-entry.ts [--n 40] [--one-by-one]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rolldown } from "vite";

const root = join(import.meta.dir, "../../../../../../..");
const nAt = process.argv.indexOf("--n");
const n = nAt > 0 ? Number(process.argv[nAt + 1]) : 40;
const generated = readFileSync(
  join(
    root,
    "plugins/apps/plugins/website/plugins/demos/plugins/lumen/bin/browser-host.generated.ts",
  ),
  "utf8",
);
const paths = [...generated.matchAll(/pluginPath: "([^"]+)"/g)]
  .map((m) => m[1]!)
  .slice(0, n);
const input = Object.fromEntries(
  paths.map((p) => [
    p.split("/plugins/").join("."),
    join(root, "plugins", p, "server/index.ts"),
  ]),
);

const external = (id: string) =>
  !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0");

const { build } = await import("vite");
const run = async (inp: Record<string, string>) =>
  (await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: { "@plugins": join(root, "plugins") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      target: "esnext",
      minify: "oxc",
      sourcemap: true,
      reportCompressedSize: false,
      rolldownOptions: {
        input: inp,
        external,
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name]/index.js",
          chunkFileNames: "[name]-[hash].mjs",
        },
      },
    },
  })) as Rolldown.RolldownOutput;

let t = performance.now();
const out = await run(input);
const multiMs = performance.now() - t;

// Which entries does each emitted chunk serve? A non-entry chunk reached by
// more than one entry is shared across artifacts: the property that must not
// hold.
const chunks = out.output.filter(
  (f): f is Rolldown.OutputChunk => f.type === "chunk",
);
const byName = new Map(chunks.map((c) => [c.fileName, c]));
const reach = new Map<string, Set<string>>();
for (const entry of chunks.filter((c) => c.isEntry)) {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const c = byName.get(f);
    for (const i of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])])
      walk(i);
  };
  walk(entry.fileName);
  for (const f of seen) {
    const s = reach.get(f) ?? new Set();
    s.add(entry.name);
    reach.set(f, s);
  }
}
const shared = [...reach.entries()].filter(
  ([f, s]) => byName.has(f) && !byName.get(f)!.isEntry && s.size > 1,
);
const entryToEntry = chunks
  .filter((c) => c.isEntry)
  .flatMap((c) =>
    c.imports
      .filter((i) => byName.get(i)?.isEntry)
      .map((i) => `${c.fileName} → ${i}`),
  );
console.log(
  `${paths.length} entries, one run: ${(multiMs / 1000).toFixed(2)} s, ${chunks.length} chunks; shared non-entry chunks: ${shared.length}; entry→entry imports: ${entryToEntry.length}`,
);
for (const [f, s] of shared.slice(0, 10)) {
  const c = byName.get(f)!;
  console.log(
    `  shared ${f} (${s.size} entries) modules: ${Object.keys(c.modules).slice(0, 5).join(", ")}`,
  );
}
for (const e of entryToEntry.slice(0, 10)) console.log(`  ${e}`);

if (process.argv.includes("--one-by-one")) {
  t = performance.now();
  for (const [k, v] of Object.entries(input)) await run({ [k]: v });
  const oneMs = performance.now() - t;
  console.log(
    `one by one: ${(oneMs / 1000).toFixed(2)} s (${(oneMs / paths.length).toFixed(0)} ms each)`,
  );
}
