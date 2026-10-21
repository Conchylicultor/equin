// Global CSS stays global (v1): ONE Tailwind v4 pass over app.css's own
// `@source` directives, emitting the single global stylesheet plus its font
// assets. app.css imports Tailwind with
// `source(none)`, so the pass scans EXACTLY the declared @source dirs — never
// automatic source detection, whose base is the vite root (the REPO ROOT
// here): on the main checkout that walked `.claude/worktrees/` (~90 agent
// checkouts, millions of files; oxide's walkdir does not honor .gitignore)
// and turned the ~5s pass into ~320s. The `tailwind-scan-covers-classes`
// check enforces source(none) stays. The pass is the dominant warm-build cost
// (~5–15s), so its output is CACHED content-addressed in the store, keyed by
// a fingerprint that errs WIDER than the true input surface:
//
//   - every not-ignored file in the worktree, enumerated with `git ls-files`
//     (tracked ∪ untracked-not-ignored) — a superset of the scanned dirs, so
//     the key can never under-cover them;
//   - every `@source` directory declared in app.css (parsed, not hardcoded —
//     today just `plugins/`, inside the repo, but an explicit walk covers a
//     declared dir even if it were gitignored or moved outside);
//   - every `@import`ed stylesheet input (parsed from app.css): package
//     imports contribute their resolved package VERSION, relative imports
//     their content hash;
//   - toolchain versions (vite, tailwindcss, @tailwindcss/vite), the minify
//     flag, and BUILDER_VERSION.
//
// Content hashing goes through the shared stat-fingerprint fast path, so a
// warm no-op key computation is one `git ls-files` + a stat sweep (~0.5s)
// instead of the full Tailwind pass. Over-inclusion (a README edit re-runs the
// pass) is safe; under-inclusion (a missed class source) would silently serve
// stale CSS — so the fingerprint errs wide.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BUILDER_VERSION, packageNameOf } from "../constants";
import { computeIdentityHash, sha256Hex } from "../hash";
import { packageVersion } from "./identity";
import { cachedAggregateHash } from "./own-files";
import { publishDir, WEB_ARTIFACTS_DIR, type FingerprintCache } from "./store";

const CSS_ROOT = join(WEB_ARTIFACTS_DIR, "css");

/** Path of the global stylesheet source (the monolith's `main.tsx` import). */
export function globalCssSource(pluginsRoot: string): string {
  return join(
    pluginsRoot,
    "primitives/plugins/css/plugins/ui-kit/web/theme/app.css",
  );
}

/** The `@source` dirs and `@import` specifiers declared in a Tailwind css file. */
export function parseCssInputs(cssSource: string): {
  sourceDirs: string[];
  importSpecs: string[];
} {
  const sourceDirs: string[] = [];
  const importSpecs: string[] = [];
  for (const m of cssSource.matchAll(
    /@source\s+(?:not\s+)?["']([^"']+)["']/g,
  )) {
    sourceDirs.push(m[1]!);
  }
  for (const m of cssSource.matchAll(
    /@import\s+(?:url\(\s*)?["']([^"']+)["']/g,
  )) {
    importSpecs.push(m[1]!);
  }
  return { sourceDirs, importSpecs };
}

// Dirs Tailwind's scanner never reads (gitignored / VCS / build output) — the
// walk exists to cover @source dirs even when git doesn't, so it mirrors the
// scanner's own exclusions rather than the artifact own-file skip list.
const WALK_SKIP = new Set(["node_modules", ".git"]);

function walkAllFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (
        WALK_SKIP.has(e.name) ||
        e.name === "dist" ||
        e.name.startsWith("dist.")
      )
        continue;
      walkAllFiles(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

/** Worktree files as git sees them: tracked ∪ untracked-not-ignored. */
function gitListFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const args of [
    ["ls-files", "-z"],
    ["ls-files", "-z", "--others", "--exclude-standard"],
  ]) {
    const stdout = execFileSync("git", args, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8");
    for (const rel of stdout.split("\0")) {
      if (rel) out.push(join(repoRoot, rel));
    }
  }
  return out;
}

/**
 * The global stylesheet's cache key. Uses (and updates) the caller's
 * fingerprint cache for the file-content aggregate's stat fast path.
 */
export async function computeGlobalCssKey(opts: {
  repoRoot: string;
  pluginsRoot: string;
  minify: boolean;
  cache: FingerprintCache;
}): Promise<string> {
  const appCssFile = globalCssSource(opts.pluginsRoot);
  const appCss = readFileSync(appCssFile, "utf8");
  const { sourceDirs, importSpecs } = parseCssInputs(appCss);

  // Toolchain versions resolve from THIS plugin (its own deps — repo root has
  // none of them under bun's isolated installs); @import packages resolve from
  // app.css's dir, exactly where the css pipeline resolves them from.
  const record: Record<string, string | number | boolean> = {
    builderVersion: BUILDER_VERSION,
    minify: opts.minify,
    vite: packageVersion("vite"),
    tailwindcss: packageVersion("tailwindcss"),
    tailwindVite: packageVersion("@tailwindcss/vite"),
    appCss: sha256Hex(appCss),
  };
  for (const spec of importSpecs) {
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

  // One deduped file set: the git enumeration (the scanner's auto-detected
  // surface) plus an explicit walk of each @source dir (covers them even if
  // gitignored). Content-hashed via the shared stat fast path.
  const files = new Set<string>(gitListFiles(opts.repoRoot));
  for (const dir of sourceDirs) {
    const abs = isAbsolute(dir) ? dir : resolve(dirname(appCssFile), dir);
    const walked: string[] = [];
    walkAllFiles(abs, walked);
    for (const f of walked) files.add(f);
  }
  record.inputs = await cachedAggregateHash({
    cacheKey: "__global-css|inputs",
    baseDir: opts.repoRoot,
    files: [...files].sort(),
    cache: opts.cache,
  });

  return computeIdentityHash(record);
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
 * Ensure the global stylesheet for `key` exists in the cache (running the
 * Tailwind pass on a miss), then install it + its font assets into the staging
 * dist. Returns the stylesheet href.
 */
export async function ensureGlobalCss(opts: {
  repoRoot: string;
  pluginsRoot: string;
  stagingDir: string;
  minify: boolean;
  key: string;
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
  const [{ build: viteBuild }, { default: tailwindcss }] = await Promise.all([
    import("vite"),
    import("@tailwindcss/vite"),
  ]);
  const workDir = mkdtempSync(join(tmpdir(), "web-artifacts-css-"));
  const outDir = join(workDir, "out");
  try {
    const entry = join(workDir, "entry.js");
    writeFileSync(
      entry,
      `import ${JSON.stringify(globalCssSource(opts.pluginsRoot))};\n`,
    );

    await viteBuild({
      configFile: false,
      logLevel: "error",
      root: opts.repoRoot,
      plugins: [tailwindcss()],
      build: {
        outDir,
        emptyOutDir: true,
        minify: opts.minify,
        cssCodeSplit: false,
        reportCompressedSize: false,
        rollupOptions: { input: entry },
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
export function pruneGlobalCssCache(): void {
  if (!existsSync(CSS_ROOT)) return;
  const now = Date.now();
  const live: { path: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(CSS_ROOT)) {
    const p = join(CSS_ROOT, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    // Leftover temp dirs from crashed builds age out at 1h regardless.
    const maxAge = name.startsWith(".tmp.") ? 60 * 60 * 1000 : CSS_MAX_AGE_MS;
    if (now - mtimeMs > maxAge) {
      rmSync(p, { recursive: true, force: true });
    } else if (!name.startsWith(".tmp.")) {
      live.push({ path: p, mtimeMs });
    }
  }
  if (live.length > CSS_MAX_ENTRIES) {
    live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const { path } of live.slice(0, live.length - CSS_TRIM_TO)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
