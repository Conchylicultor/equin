// What the global stylesheet costs when it is compiled from a candidate list
// instead of a scan. It times, separately:
// - compiling app.css (`@tailwindcss/node`);
// - Tailwind's own scan of its declared sources (`@tailwindcss/oxide`);
// - building from the scanned candidates, and optimizing the result;
// - extracting candidates per file (what a per-artifact record would hold)
//   over the same files, and their union.
// The union's stylesheet must equal the scan's.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-tailwind.ts [--runs 3]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { globalCssSource } from "../core/internal/global-css";

const root = join(import.meta.dir, "../../../../../../..");
const runsAt = process.argv.indexOf("--runs");
const runs = runsAt > 0 ? Number(process.argv[runsAt + 1]) : 3;
const appCssFile = globalCssSource(join(root, "plugins"));
const appCss = readFileSync(appCssFile, "utf8");

const time = async <T>(f: () => T | Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const v = await f();
  return [v, performance.now() - t];
};

for (let run = 1; run <= runs; run++) {
  const [compiler, compileMs] = await time(() =>
    compile(appCss, { base: dirname(appCssFile), onDependency: () => {} }),
  );
  const scanner = new Scanner({ sources: compiler.sources });
  const [scanned, scanMs] = await time(() => scanner.scan());
  const files = scanner.files;

  // Per plugin (one batched call each, file paths so oxide reads them), as a
  // per-artifact record would extract it.
  const [union, perFileMs] = await time(() => {
    const groups = new Map<string, string[]>();
    for (const file of files) {
      const i = file.lastIndexOf("/plugins/");
      const key = file.slice(0, file.indexOf("/", i + 9));
      const g = groups.get(key) ?? [];
      g.push(file);
      groups.set(key, g);
    }
    const u = new Set<string>();
    for (const base of groups.keys()) {
      const s = new Scanner({
        sources: [
          { base, pattern: "**/*", negated: false },
          { base, pattern: "plugins/**/*", negated: true },
        ],
      });
      for (const c of s.scan()) u.add(c);
    }
    return u;
  });
  const scannedSet = new Set(scanned);
  const onlyUnion = [...union].filter((c) => !scannedSet.has(c));
  const onlyScan = scanned.filter((c) => !union.has(c));
  console.log(
    `  only in union: ${onlyUnion.length} e.g. ${onlyUnion.slice(0, 8).join(" ")}\n  only in scan: ${onlyScan.length} e.g. ${onlyScan.slice(0, 8).join(" ")}`,
  );

  const [css, buildMs] = await time(() => compiler.build(scanned));
  const compiler2 = await compile(appCss, {
    base: dirname(appCssFile),
    onDependency: () => {},
  });
  const [cssUnion, buildUnionMs] = await time(() =>
    compiler2.build([...union]),
  );
  // Shipped scope: only the folders a page artifact inlines.
  const shipped = new Set<string>();
  const SHIPPED = ["web", "core", "shared", "exhibits", "prewarm"];
  const bases = new Set(
    files.map((file) => {
      const i = file.lastIndexOf("/plugins/");
      return file.slice(0, file.indexOf("/", i + 9));
    }),
  );
  for (const base of bases) {
    const s = new Scanner({
      sources: SHIPPED.map((f) => ({
        base: join(base, f),
        pattern: "**/*",
        negated: false,
      })),
    });
    for (const c of s.scan()) shipped.add(c);
  }
  const compiler3 = await compile(appCss, {
    base: dirname(appCssFile),
    onDependency: () => {},
  });
  const cssShipped = compiler3.build([...shipped]);
  const rulesOf = (c: string) =>
    new Set(
      [...c.matchAll(/^\s*([^{}@\n][^{}\n]*)\{/gm)].map((m) => m[1]!.trim()),
    );
  const all = rulesOf(css);
  const sh = rulesOf(cssShipped);
  const dropped = [...all].filter((r) => !sh.has(r));
  const added = [...sh].filter((r) => !all.has(r));
  console.log(
    `  shipped scope: ${shipped.size} candidates, css ${(cssShipped.length / 1024).toFixed(0)} KB; selectors dropped ${dropped.length} (e.g. ${dropped.slice(0, 12).join(" | ")}), added ${added.length}`,
  );
  // The same scope, each file passed as its own source (what a per-artifact
  // record built from the address's exact file list would do).
  const tFiles = performance.now();
  const byFile = new Set<string>();
  const perBase = new Map<string, string[]>();
  for (const file of files) {
    const i = file.lastIndexOf("/plugins/");
    const base = file.slice(0, file.indexOf("/", i + 9));
    const folder = file.slice(base.length + 1).split("/")[0]!;
    if (!SHIPPED.includes(folder)) continue;
    const g = perBase.get(base) ?? [];
    g.push(file);
    perBase.set(base, g);
  }
  for (const g of perBase.values()) {
    const s = new Scanner({
      sources: g.map((f) => ({
        base: dirname(f),
        pattern: f.slice(dirname(f).length + 1),
        negated: false,
      })),
    });
    for (const c of s.scan()) byFile.add(c);
  }
  const sameAsFolders =
    byFile.size === shipped.size && [...byFile].every((c) => shipped.has(c));
  console.log(
    `  per-file sources: ${perBase.size} plugins in ${(performance.now() - tFiles).toFixed(0)} ms, ${byFile.size} candidates, ${sameAsFolders ? "same as folder sources" : "DIFFERS from folder sources"}`,
  );
  if (process.argv.includes("--dump-dropped"))
    writeFileSync("/tmp/bp3a-base/dropped.txt", dropped.join("\n") + "\n");
  const [optimized, optimizeMs] = await time(
    () => optimize(css, { minify: true }).code,
  );

  console.log(
    [
      `run ${run}:`,
      `compile ${compileMs.toFixed(0)} ms`,
      `scan ${scanMs.toFixed(0)} ms (${files.length} files, ${scanned.length} candidates)`,
      `per-plugin extract ${perFileMs.toFixed(0)} ms (union ${union.size})`,
      `build ${buildMs.toFixed(0)} ms (union build ${buildUnionMs.toFixed(0)} ms)`,
      `optimize ${optimizeMs.toFixed(0)} ms`,
      `css ${(css.length / 1024).toFixed(0)} KB → ${(optimized.length / 1024).toFixed(0)} KB min`,
      `union css ${cssUnion === css ? "identical" : `DIFFERS (${cssUnion.length} vs ${css.length} bytes)`}`,
    ].join("\n  "),
  );
}
