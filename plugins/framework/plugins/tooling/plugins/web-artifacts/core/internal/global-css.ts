// The global stylesheet: ONE Tailwind v4 compile of app.css over the union of
// the composition's artifacts' class candidates. Each artifact records its own
// candidates when it is built (`tailwind-candidates.ts`, read from exactly the
// files its address hashed), so the union is a combination of per-artifact
// records — no file walk, no scan, no fingerprint of `plugins/`. An edit that
// adds no candidate (a comment, a doc, a lock file) leaves the union, and so
// the stylesheet, unchanged; one that does recompiles from the list (~0.3 s:
// compile app.css, build the candidates, optimize).
//
// app.css still imports Tailwind with `source(none)`: nothing here reads its
// `@source` entries (the candidates come from the artifacts), and auto-detection
// from the vite root (the REPO ROOT here) walked `.claude/worktrees/` on the
// main checkout (~90 checkouts, millions of files) — ~5s became ~320s. The
// `tailwind-scan-covers-classes` check keeps both: source(none), and every
// class-authoring file inside some artifact.
//
// The output is cached content-addressed in the store, keyed by what the
// compile reads: the candidate union, app.css, every `@import`ed stylesheet
// (a package's resolved version, a relative file's content), the toolchain
// versions, the minify flag and BUILDER_VERSION. The key is a combination of
// records, and a miss costs one compile from the list.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Plugin as VitePlugin } from "vite";
import { BUILDER_VERSION, packageNameOf } from "../constants";
import { computeIdentityHash, sha256Hex } from "../hash";
import { packageVersion } from "./identity";
import { publishDir, pruneCacheDir, WEB_ARTIFACTS_DIR } from "./store";
import { servedDistTargets } from "./served-dists";

const CSS_ROOT = join(WEB_ARTIFACTS_DIR, "css");

/** Path of the global stylesheet source (the monolith's `main.tsx` import). */
export function globalCssSource(pluginsRoot: string): string {
  return join(
    pluginsRoot,
    "primitives/plugins/css/plugins/ui-kit/web/theme/app.css",
  );
}

/** The `@import` specifiers declared in a Tailwind css file. */
export function parseCssImports(cssSource: string): string[] {
  const importSpecs: string[] = [];
  for (const m of cssSource.matchAll(
    /@import\s+(?:url\(\s*)?["']([^"']+)["']/g,
  )) {
    importSpecs.push(m[1]!);
  }
  return importSpecs;
}

/**
 * The union of the given artifacts' Tailwind candidates, sorted. Throws on a
 * meta that carries none: one written before candidates were recorded cannot
 * be told apart from "this artifact authors no class", and a missing class is
 * a silently unstyled page.
 */
export function unionCandidates(
  metas: ReadonlyArray<{ tailwindCandidates?: readonly string[] }>,
  labelOf: (index: number) => string,
): string[] {
  const union = new Set<string>();
  metas.forEach((meta, i) => {
    if (!Array.isArray(meta.tailwindCandidates)) {
      throw new Error(
        `global css: artifact ${labelOf(i)} records no tailwindCandidates (built by an older builder?)`,
      );
    }
    for (const c of meta.tailwindCandidates) union.add(c);
  });
  return [...union].sort();
}

/** The global stylesheet's cache key, over the candidate union and what the compile reads. */
export function computeGlobalCssKey(opts: {
  pluginsRoot: string;
  minify: boolean;
  candidates: readonly string[];
}): string {
  const appCssFile = globalCssSource(opts.pluginsRoot);
  const appCss = readFileSync(appCssFile, "utf8");

  // Toolchain versions resolve from THIS plugin (its own deps — repo root has
  // none of them under bun's isolated installs); @import packages resolve from
  // app.css's dir, exactly where the compile resolves them from.
  const record: Record<string, string | number | boolean> = {
    builderVersion: BUILDER_VERSION,
    minify: opts.minify,
    vite: packageVersion("vite"),
    tailwindcss: packageVersion("tailwindcss"),
    tailwindNode: packageVersion("@tailwindcss/node"),
    appCss: sha256Hex(appCss),
    candidates: sha256Hex(opts.candidates.join("\n")),
  };
  for (const spec of parseCssImports(appCss)) {
    if (spec.startsWith(".")) {
      record[`import:${spec}`] = sha256Hex(
        readFileSync(resolve(dirname(appCssFile), spec)),
      );
    } else {
      // A package stylesheet (`tailwindcss`, `shadcn/tailwind.css`, fontsource
      // families): its resolved version pins the content.
      record[`import:${spec}`] = packageVersion(
        packageNameOf(spec),
        dirname(appCssFile),
      );
    }
  }
  return computeIdentityHash(record);
}

/**
 * Serves the compiled stylesheet to vite as a module sitting beside app.css,
 * so its `url()`s (rewritten by the compile relative to app.css's dir — the
 * fontsource files) resolve exactly as they did from app.css itself.
 */
function compiledCssPlugin(id: string, css: string): VitePlugin {
  return {
    name: "global-css-compiled",
    enforce: "pre",
    resolveId: (source) => (source === id ? id : null),
    load: (loaded) => (loaded === id ? css : null),
  };
}

function cssCacheDir(key: string): string {
  return join(CSS_ROOT, `css.${key.slice(0, 16)}`);
}

interface CssCacheMeta {
  cssName: string;
  key: string;
}

/** True iff the global stylesheet for `key` is already in the cache. */
export function hasGlobalCssCache(key: string): boolean {
  return existsSync(join(cssCacheDir(key), "meta.json"));
}

/** Copy every cached asset (stylesheet + fonts) into the staging dist. */
function installAssets(cacheDir: string, stagingDir: string): void {
  const assetsDest = join(stagingDir, "assets");
  mkdirSync(assetsDest, { recursive: true });
  for (const name of readdirSync(cacheDir)) {
    if (name === "meta.json") continue;
    cpSync(join(cacheDir, name), join(assetsDest, name));
  }
}

/**
 * Ensure the global stylesheet for `key` exists in the cache (compiling
 * `candidates` on a miss), then install it + its font assets into the staging
 * dist. Returns the stylesheet href.
 */
export async function ensureGlobalCss(opts: {
  repoRoot: string;
  pluginsRoot: string;
  stagingDir: string;
  minify: boolean;
  key: string;
  candidates: readonly string[];
}): Promise<{ href: string; cached: boolean }> {
  const cacheDir = cssCacheDir(opts.key);
  const metaFile = join(cacheDir, "meta.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as CssCacheMeta;
    const now = new Date();
    utimesSync(cacheDir, now, now); // keep live cache entries from aging out
    installAssets(cacheDir, opts.stagingDir);
    return { href: `/assets/${meta.cssName}`, cached: true };
  }

  // Lazy toolchain load — see vite-builder.ts (CLI-startup cost).
  const [{ build: viteBuild }, { compile, optimize }] = await Promise.all([
    import("vite"),
    import("@tailwindcss/node"),
  ]);
  const appCssFile = globalCssSource(opts.pluginsRoot);
  const compiler = await compile(readFileSync(appCssFile, "utf8"), {
    base: dirname(appCssFile),
    from: appCssFile,
    shouldRewriteUrls: true,
    onDependency: () => {},
  });
  // As `@tailwindcss/vite` does in a build: lightningcss lowers the output
  // (nesting, prefixes) before vite's own minify.
  const compiled = optimize(compiler.build([...opts.candidates]), {
    minify: false,
  }).code;
  const compiledId = join(dirname(appCssFile), "__global.compiled.css");

  const workDir = mkdtempSync(join(tmpdir(), "web-artifacts-css-"));
  const outDir = join(workDir, "out");
  try {
    const entry = join(workDir, "entry.js");
    writeFileSync(entry, `import ${JSON.stringify(compiledId)};\n`);

    // vite turns the compiled CSS's `url()`s into hashed assets and minifies.
    await viteBuild({
      configFile: false,
      logLevel: "error",
      root: opts.repoRoot,
      plugins: [compiledCssPlugin(compiledId, compiled)],
      build: {
        outDir,
        emptyOutDir: true,
        minify: opts.minify,
        cssCodeSplit: false,
        reportCompressedSize: false,
        rolldownOptions: { input: entry },
      },
    });

    // Publish into the cache atomically (publishDir: sidecars, meta.json last,
    // rename), then install into staging from the emitted output.
    const assetsSrc = join(outDir, "assets");
    mkdirSync(CSS_ROOT, { recursive: true });
    const tmpDest = join(
      CSS_ROOT,
      `.tmp.${opts.key.slice(0, 16)}.${process.pid}`,
    );
    rmSync(tmpDest, { recursive: true, force: true });
    mkdirSync(tmpDest, { recursive: true });
    let cssName: string | null = null;
    for (const name of readdirSync(assetsSrc)) {
      if (name.endsWith(".js")) continue; // the empty entry chunk
      cpSync(join(assetsSrc, name), join(tmpDest, name));
      if (name.endsWith(".css")) {
        if (cssName !== null) {
          throw new Error(
            `global CSS pass emitted more than one stylesheet: ${cssName}, ${name}`,
          );
        }
        cssName = name;
      }
    }
    if (cssName === null) {
      throw new Error("global CSS pass emitted no stylesheet");
    }
    const meta: CssCacheMeta = { cssName, key: opts.key };
    await publishDir({
      tmpDir: tmpDest,
      dest: cacheDir,
      meta,
      isComplete: () => hasGlobalCssCache(opts.key),
    });
    installAssets(cacheDir, opts.stagingDir);
    return { href: `/assets/${cssName}`, cached: false };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Pruning bounds — same policy as the vendor sets (age, then count). An entry is
// one built stylesheet plus its font assets (~0.6 MB measured, 134 live in 14
// days). Age is the evictor that matters; the count is a disk backstop sized 4×
// clear of the working set, bounding the dir at ~360 MB worst case.
const CSS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CSS_MAX_ENTRIES = 600;
const CSS_TRIM_TO = 450;

/** Prune aged css cache entries, then cap total count (same policy as the vendor sets). */
export function pruneGlobalCssCache(
  referenced: ReadonlySet<string> = servedDistTargets(),
): void {
  pruneCacheDir({
    root: CSS_ROOT,
    maxAgeMs: CSS_MAX_AGE_MS,
    maxEntries: CSS_MAX_ENTRIES,
    trimTo: CSS_TRIM_TO,
    referenced,
  });
}
