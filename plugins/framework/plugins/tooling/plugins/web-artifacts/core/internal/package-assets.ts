// npm packages that fetch a file by URL — `new URL("./pglite.wasm",
// import.meta.url)` — expect it beside the module holding that expression.
// The vendor build bundles the module into an output file (an entry or a
// split chunk) but carries no such file. So after the build, every such
// literal in an output file is rewritten to the file's own content-addressed
// URL, `/artifacts/<sha16>.<name>/<name>` — an entry of the package-asset
// store, linked into the dist by name (`vendorAssetLinks`, `vendors.ts`).
//
// The bytes live ONCE in the store, an entry per file content, published (and
// so precompressed: PGlite's 10 MB wasm takes ~5 s at brotli q9) the first
// time any vendor set needs it. Rebuilding the vendor set — whenever any
// package is added or bumped — never recompresses them, and their URL
// changes only with their bytes: the page and the worker fetch one URL, which
// a returning visitor already holds while the asset is unchanged.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { join, basename, extname, isAbsolute, posix } from "node:path";
import type { Metafile } from "esbuild";
import { sha256Hex } from "../hash";
import { publishDir, WEB_ARTIFACTS_DIR, type CachePrunePolicy } from "./store";

const ASSETS_ROOT = joinAppPath(WEB_ARTIFACTS_DIR, "package-assets");

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

// esbuild names a module outside the file namespace `<namespace>:<path>` —
// `(disabled):<path>` for one a package's `browser` field maps to `false`
// (its bytes are an empty stub, not the file at <path>). A file-namespace
// input is a plain path, with no colon before its first separator.
const NAMESPACED_INPUT_RE = /^[^/\\]*:/;

/** Whether a metafile input is a file on disk (not a namespaced module). */
export function isFileInput(inPath: string): boolean {
  return !NAMESPACED_INPUT_RE.test(inPath);
}

/** A package-asset store entry's path — the one spelling, so roots compare equal. */
export function packageAssetPath(
  name: string,
  assetsRoot: AppPath = ASSETS_ROOT,
): AppPath {
  return joinAppPath(assetsRoot, name);
}

/**
 * The asset store entry holding `file`'s bytes (`<sha16>.<basename>`, the file
 * inside it under its own name); published on first use. Pinned into the
 * build's lease before it is checked or published (`lease.ts`), so a
 * concurrent prune cannot remove it before the dist links it. Returns its name.
 */
async function ensurePackageAsset(
  file: AppPath,
  pin: (paths: readonly AppPath[]) => Promise<void>,
  assetsRoot: AppPath,
): Promise<string> {
  const name = `${sha256Hex(readFileSync(file)).slice(0, 16)}.${basename(file)}`;
  const dir = packageAssetPath(name, assetsRoot);
  await pin([dir]);
  if (existsSync(joinAppPath(dir, "meta.json"))) return name;
  mkdirSync(assetsRoot, { recursive: true });
  const tmp = joinAppPath(assetsRoot, `.tmp.${name}.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  copyFileSync(file, joinAppPath(tmp, basename(file)));
  await publishDir({
    tmpDir: tmp,
    dest: dir,
    meta: { source: file },
    isComplete: () => existsSync(joinAppPath(dir, "meta.json")),
  });
  return name;
}

/** The URL a package asset entry serves its file at. */
export function packageAssetUrl(name: string): string {
  // `<sha16>.<basename>`: the file inside is named by the part after the hash.
  return `/artifacts/${name}/${name.slice(name.indexOf(".") + 1)}`;
}

/** One ref string of an output, and the URL it must fetch instead. */
export interface UrlRefRewrite {
  /** The literal as a module wrote it (`./x.wasm`, `x.wasm`, `../x.wasm`). */
  ref: string;
  url: string;
}

// The same file named two ways (`./x`, `x`) is one ref.
function refKey(ref: string): string {
  return posix.normalize(ref);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

/** A sourcemap segment's VLQ fields (each relative, as encoded). */
function decodeSegment(segment: string): number[] {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of segment) {
    const digit = B64_INDEX.get(c);
    if (digit === undefined)
      throw new Error(`sourcemap: bad VLQ digit "${c}" in "${segment}"`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  if (shift !== 0)
    throw new Error(`sourcemap: truncated VLQ segment "${segment}"`);
  return fields;
}

function encodeSegment(fields: readonly number[]): string {
  let out = "";
  for (const field of fields) {
    let value = field < 0 ? (-field << 1) | 1 : field << 1;
    do {
      let digit = value & 31;
      value >>>= 5;
      if (value > 0) digit |= 32;
      out += B64[digit];
    } while (value > 0);
  }
  return out;
}

/**
 * Rewrite one output's URL refs and its sourcemap `mappings` with it. Each
 * matching literal's string is replaced; every later segment on the same
 * generated line moves by the length difference (columns are UTF-16 code
 * units — JS string indices), so the map still resolves past the literal.
 * Every other line of `mappings` is left byte-identical. A literal absent
 * from `refs` (another package's, an `https:` URL) is left alone. Throws when
 * one ref is given two different URLs, and when a ref has no literal in
 * `code` — the output would fetch a file nothing serves (esbuild printed it in
 * a form `URL_REF_RE` does not read), a 404 no other gate sees.
 */
export function rewriteUrlRefs(
  code: string,
  mappings: string,
  refs: readonly UrlRefRewrite[],
): { code: string; mappings: string } {
  const urlOf = new Map<string, string>();
  for (const { ref, url } of refs) {
    const key = refKey(ref);
    const prior = urlOf.get(key);
    if (prior !== undefined && prior !== url) {
      throw new Error(
        `vendor assets: one output fetches "${ref}" by URL, but it names two files (${prior}, ${url})`,
      );
    }
    urlOf.set(key, url);
  }
  const rewritten = new Set<string>();
  // Per generated line: each edit's column and length difference, in order.
  const shifts = new Map<number, Array<{ end: number; delta: number }>>();
  let line = 0;
  let lineStart = 0;
  let scanned = 0;
  let out = "";
  let copied = 0;
  for (const m of code.matchAll(URL_REF_RE)) {
    const key = refKey(m[2]!);
    const url = urlOf.get(key);
    if (url === undefined) continue;
    rewritten.add(key);
    const start = m.index + m[0].indexOf(m[1]!) + 1; // the string's content
    const end = start + m[2]!.length;
    for (let i = code.indexOf("\n", scanned); i !== -1 && i < start;) {
      line++;
      lineStart = i + 1;
      i = code.indexOf("\n", i + 1);
    }
    scanned = start;
    let edits = shifts.get(line);
    if (edits === undefined) shifts.set(line, (edits = []));
    edits.push({ end: end - lineStart, delta: url.length - m[2]!.length });
    out += code.slice(copied, start) + url;
    copied = end;
  }
  const missed = [...urlOf.keys()].filter((k) => !rewritten.has(k));
  if (missed.length > 0) {
    throw new Error(
      `vendor assets: the output holds no \`new URL("<ref>", import.meta.url)\` literal for ${missed
        .map((k) => `"${k}"`)
        .join(
          ", ",
        )}, which its modules fetch by URL — it would 404 at run time`,
    );
  }
  if (copied === 0) return { code, mappings };
  out += code.slice(copied);
  const lines = mappings.split(";");
  for (const [n, edits] of shifts) {
    const segments = lines[n];
    if (segments === undefined || segments === "") continue;
    let prevIn = 0;
    let prevOut = 0;
    lines[n] = segments
      .split(",")
      .map((segment) => {
        const fields = decodeSegment(segment);
        const col = prevIn + fields[0]!;
        prevIn = col;
        let moved = col;
        for (const e of edits) if (col >= e.end) moved += e.delta;
        fields[0] = moved - prevOut;
        prevOut = moved;
        return encodeSegment(fields);
      })
      .join(",");
  }
  return { code: out, mappings: lines.join(";") };
}

/**
 * Point every URL-fetched asset of the bundled npm modules at its own store
 * entry: each output file's `new URL("<ref>", import.meta.url)` literals are
 * rewritten in place (its `.js.map` with them), and each asset is published
 * once (`ensurePackageAsset`). Returns the entry names the outputs fetch,
 * sorted. Throws on a reference to a file the package does not ship — the
 * module would fail when it fetches it.
 */
export async function rewritePackageAssetUrls(opts: {
  metafile: Metafile;
  /** The dir esbuild resolved the metafile's relative paths against. */
  cwd: AppPath;
  /** Pin an asset entry into the build's lease (`lease.ts`). */
  pin: (paths: readonly AppPath[]) => Promise<void>;
  /** The package-asset store; the shared one unless a test names its own. */
  assetsRoot?: AppPath;
}): Promise<string[]> {
  const assetsRoot = opts.assetsRoot ?? ASSETS_ROOT;
  const names = new Set<string>();
  const refsOf = new Map<string, string[]>();
  const entryOf = new Map<string, string>();
  for (const [outPath, output] of Object.entries(opts.metafile.outputs)) {
    if (!outPath.endsWith(".js")) continue;
    const rewrites: UrlRefRewrite[] = [];
    for (const [inPath, inOutput] of Object.entries(output.inputs)) {
      if (inOutput.bytesInOutput === 0) continue; // tree-shaken out of this output
      if (!inPath.includes("node_modules")) continue; // a virtual entry, repo code
      if (!isFileInput(inPath)) continue; // a disabled stub: no source to read
      const input = asAppPath(join(opts.cwd, inPath));
      let refs = refsOf.get(input);
      if (refs === undefined) {
        refs = urlAssetRefs(readFileSync(input, "utf8"));
        refsOf.set(input, refs);
      }
      for (const ref of refs) {
        // Relative to the module that fetches it.
        const asset = asAppPath(join(appPathParent(input), ref));
        if (!existsSync(asset)) {
          throw new Error(
            `vendor assets: ${inPath} fetches ${ref} by URL, but ${asset} does not exist`,
          );
        }
        let name = entryOf.get(asset);
        if (name === undefined) {
          name = await ensurePackageAsset(asset, opts.pin, assetsRoot);
          entryOf.set(asset, name);
        }
        names.add(name);
        rewrites.push({ ref, url: packageAssetUrl(name) });
      }
    }
    if (rewrites.length === 0) continue;
    // esbuild's metafile paths are relative to its cwd and climb out of it
    // into the vendor cache it wrote: resolved, not joined under.
    const outFile = asAppPath(join(opts.cwd, outPath));
    const mapFile = asAppPath(`${outFile}.map`);
    if (!existsSync(mapFile)) {
      throw new Error(
        `vendor assets: ${outFile} fetches package assets by URL but has no sourcemap (${mapFile})`,
      );
    }
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as {
      mappings: string;
    };
    const next = rewriteUrlRefs(
      readFileSync(outFile, "utf8"),
      map.mappings,
      rewrites,
    );
    writeFileSync(outFile, next.code);
    writeFileSync(mapFile, JSON.stringify({ ...map, mappings: next.mappings }));
  }
  return [...names].sort();
}

// An entry is a root while a dist links it or a cached vendor set names it
// (`VendorSetMeta.packageAssets`, read by `pruneWebArtifactCaches` under the
// store lock, `lease.ts`): a reused set must never outlive the files its
// chunks fetch. Only an entry neither names ages out.
export const PACKAGE_ASSETS_PRUNE_POLICY: CachePrunePolicy = {
  root: ASSETS_ROOT,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxUnreferenced: 200,
  trimTo: 150,
};
