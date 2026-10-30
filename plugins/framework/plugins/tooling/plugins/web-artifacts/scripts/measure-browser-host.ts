// What the browser host's whole-graph worker bundle is made of: its bytes split
// into repo code (by the folder each module sits in), PGlite's code, PGlite's
// assets and every other npm package. Builds the same graph `browser-hosts.ts`
// bundles (the host entry, dynamic imports inlined, PGlite's assets by URL),
// in memory, and reads rolldown's per-module rendered lengths.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-browser-host.ts [--minify] [--json <file>]

import { writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { Rolldown } from "vite";
import { isBrowserHostSpecifier } from "../core/browser-host-specifier";

const root = join(import.meta.dir, "../../../../../../..");
const entry = join(
  root,
  "plugins/apps/plugins/website/plugins/demos/plugins/lumen/bin/browser-host.ts",
);
const minify = process.argv.includes("--minify");
const jsonAt = process.argv.indexOf("--json");
const jsonOut = jsonAt > 0 ? process.argv[jsonAt + 1] : undefined;

type Bucket = { modules: number; bytes: number };
const buckets = new Map<string, Bucket>();
const add = (key: string, bytes: number) => {
  const b = buckets.get(key) ?? { modules: 0, bytes: 0 };
  b.modules += 1;
  b.bytes += bytes;
  buckets.set(key, b);
};

// The folder a repo module sits in: the last runtime folder on its path.
const FOLDER_RE = /\/(server|core|shared|web|bin|machine|data)\//g;
function bucketOf(id: string): string {
  const path = id.split("?")[0]!;
  const parts = path.split(sep);
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0) {
    const pkg = parts[nm + 1]!.startsWith("@")
      ? `${parts[nm + 1]}/${parts[nm + 2]}`
      : parts[nm + 1]!;
    return pkg === "@electric-sql/pglite" ? "npm: pglite" : "npm: other";
  }
  const rel = relative(root, path);
  if (rel.startsWith("..")) return "other";
  const folders = [...`/${rel}`.matchAll(FOLDER_RE)];
  return `repo: ${folders.at(-1)?.[1] ?? "(none)"}`;
}

const npmPkgs = new Map<string, number>();
const perModule: { id: string; key: string; bytes: number }[] = [];
const t0 = performance.now();
const { build } = await import("vite");
const out = (await build({
  configFile: false,
  logLevel: "warn",
  root,
  base: "./",
  resolve: { alias: { "@plugins": join(root, "plugins") } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    target: "esnext",
    minify: minify ? "oxc" : false,
    assetsInlineLimit: 0,
    modulePreload: false,
    reportCompressedSize: false,
    rolldownOptions: {
      input: { worker: entry },
      external: isBrowserHostSpecifier,
      output: { format: "es", inlineDynamicImports: true },
    },
  },
})) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
const buildMs = performance.now() - t0;

let total = 0;
let gz = 0;
for (const o of Array.isArray(out) ? out : [out]) {
  for (const f of o.output) {
    if (f.type === "chunk") {
      total += f.code.length;
      gz += gzipSync(f.code).length;
      for (const [id, m] of Object.entries(f.modules)) {
        const key = bucketOf(id);
        add(key, m.renderedLength);
        perModule.push({
          id: relative(root, id),
          key,
          bytes: m.renderedLength,
        });
        if (key.startsWith("npm")) {
          const parts = id.split(sep);
          const nm = parts.lastIndexOf("node_modules");
          const pkg = parts[nm + 1]!.startsWith("@")
            ? `${parts[nm + 1]}/${parts[nm + 2]}`
            : parts[nm + 1]!;
          npmPkgs.set(pkg, (npmPkgs.get(pkg) ?? 0) + m.renderedLength);
        }
      }
    } else {
      const bytes =
        typeof f.source === "string" ? f.source.length : f.source.byteLength;
      total += bytes;
      add(`asset: ${f.fileName.replace(/-[\w-]{8}(\.\w+)$/, "$1")}`, bytes);
    }
  }
}

const rows = [...buckets.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const mb = (n: number) => (n / 1_048_576).toFixed(2);
console.log(
  `browser host bundle (${minify ? "minified" : "unminified"}): ${mb(total)} MB total, JS ${mb(gz)} MB gzip, built in ${(buildMs / 1000).toFixed(1)} s`,
);
for (const [k, b] of rows) {
  console.log(
    `  ${k.padEnd(34)} ${String(b.modules).padStart(5)} modules  ${mb(b.bytes).padStart(7)} MB  ${((100 * b.bytes) / total).toFixed(1).padStart(5)} %`,
  );
}
console.log("  top npm packages:");
for (const [p, n] of [...npmPkgs.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)) {
  console.log(`    ${p.padEnd(40)} ${mb(n)} MB`);
}
for (const key of ["repo: shared", "repo: (none)", "repo: data"]) {
  console.log(`  largest in ${key}:`);
  for (const m of perModule
    .filter((m) => m.key === key)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6)) {
    console.log(`    ${(m.bytes / 1024).toFixed(0).padStart(6)} KB  ${m.id}`);
  }
}
if (jsonOut !== undefined) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        minify,
        totalBytes: total,
        jsGzipBytes: gz,
        buildMs,
        buckets: Object.fromEntries(rows),
        npm: Object.fromEntries(npmPkgs),
      },
      null,
      2,
    ),
  );
}
