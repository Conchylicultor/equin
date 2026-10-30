// npm packages that fetch a file by URL — `new URL("./pglite.wasm",
// import.meta.url)` — expect it beside the module holding that expression.
// The vendor build bundles the module into an output file (an entry or a
// split chunk) but carries no such file. So after the build, every
// non-code file a bundled npm module names that way is placed beside each
// output file holding the module.
//
// The bytes live ONCE in the package-asset store, an entry per file content,
// published (and so precompressed: PGlite's 10 MB wasm takes ~5 s at brotli
// q9) the first time any vendor set needs it. A vendor set hard-links the
// file and its sidecars, so rebuilding the vendor set — whenever any package
// is added or bumped — never recompresses them: their cost follows a change
// to the package that ships them.

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import type { Metafile } from "esbuild";
import { sha256Hex } from "../hash";
import { publishDir, pruneCacheDir, WEB_ARTIFACTS_DIR } from "./store";

const ASSETS_ROOT = join(WEB_ARTIFACTS_DIR, "package-assets");

// A literal `new URL("<relative>", import.meta.url)`.
const URL_REF_RE =
  /new\s+URL\(\s*(["'])((?:\.{1,2}\/)?[^"'\s:]+)\1\s*,\s*import\.meta\.url\s*\)/g;

// A referenced module is code the bundler would have to build, not an asset.
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

/** The relative non-code files one module's source fetches by URL. */
export function urlAssetRefs(source: string): string[] {
  const refs = new Set<string>();
  for (const m of source.matchAll(URL_REF_RE)) {
    const ref = m[2]!;
    if (isAbsolute(ref) || CODE_EXTS.has(extname(ref))) continue;
    refs.add(ref);
  }
  return [...refs].sort();
}

/** The asset store entry holding `file`'s bytes; published on first use. */
async function ensurePackageAsset(file: string): Promise<string> {
  const dir = join(
    ASSETS_ROOT,
    `${sha256Hex(readFileSync(file)).slice(0, 16)}.${basename(file)}`,
  );
  if (existsSync(join(dir, "meta.json"))) return join(dir, basename(file));
  mkdirSync(ASSETS_ROOT, { recursive: true });
  const tmp = join(ASSETS_ROOT, `.tmp.${basename(dir)}.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  copyFileSync(file, join(tmp, basename(file)));
  await publishDir({
    tmpDir: tmp,
    dest: dir,
    meta: { source: file },
    isComplete: () => existsSync(join(dir, "meta.json")),
  });
  return join(dir, basename(file));
}

/**
 * Place every URL-fetched asset of the bundled npm modules beside the output
 * files holding them, as hard links into the asset store (with their
 * sidecars). Returns the placed paths: already compressed, so the vendor
 * set's publish must not compress them again. Throws on a reference to a file
 * the package does not ship — the module would fail when it fetches it.
 */
export async function placePackageAssets(opts: {
  metafile: Metafile;
  /** The dir esbuild resolved the metafile's relative paths against. */
  cwd: string;
}): Promise<Set<string>> {
  const placed = new Set<string>();
  const refsOf = new Map<string, string[]>();
  for (const [outPath, output] of Object.entries(opts.metafile.outputs)) {
    if (!outPath.endsWith(".js")) continue;
    const outDir = dirname(resolve(opts.cwd, outPath));
    for (const inPath of Object.keys(output.inputs)) {
      if (!inPath.includes("node_modules")) continue; // a virtual entry, repo code
      const input = resolve(opts.cwd, inPath);
      let refs = refsOf.get(input);
      if (refs === undefined) {
        refs = urlAssetRefs(readFileSync(input, "utf8"));
        refsOf.set(input, refs);
      }
      for (const ref of refs) {
        const asset = resolve(dirname(input), ref);
        if (!existsSync(asset)) {
          throw new Error(
            `vendor assets: ${inPath} fetches ${ref} by URL, but ${asset} does not exist`,
          );
        }
        const dest = resolve(outDir, ref);
        if (placed.has(dest)) continue;
        const stored = await ensurePackageAsset(asset);
        mkdirSync(dirname(dest), { recursive: true });
        linkSync(stored, dest);
        for (const ext of [".br", ".gz"]) {
          if (existsSync(`${stored}${ext}`))
            linkSync(`${stored}${ext}`, `${dest}${ext}`);
        }
        placed.add(dest);
      }
    }
  }
  return placed;
}

// A vendor set holds hard links, never a path into this store, so an aged-out
// entry costs nothing a served dist still needs — only the next vendor build
// that wants it republishes it.
const ASSETS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Prune asset entries no vendor build used for two weeks. */
export function prunePackageAssets(): void {
  pruneCacheDir({
    root: ASSETS_ROOT,
    maxAgeMs: ASSETS_MAX_AGE_MS,
    maxEntries: 200,
    trimTo: 150,
    referenced: new Set(),
  });
}
