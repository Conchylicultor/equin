// Persisted vendor-resolution cache: `{resolveDir, specifier}` →
// `{entryFile, version, cjs, wrapper}`, the tuple the vendor SET HASH is
// computed from. Resolution is pure filesystem work (an esbuild resolver probe
// plus a package.json walk and one or two lexer passes per specifier), and on a
// warm build every answer is already known and unchanged — so the fix is to not
// recompute it. The three `resolveVendorSet` call sites are separate PROCESSES
// (the build, and the map-in-sync check's two), which is why the cache is on
// disk rather than in memory.
//
// A record is a hit only when BOTH hold:
//
//   - the `gate` matches — one digest over the repo's `bun.lock` contents, the
//     esbuild version, and the builder version + source digest. The lockfile
//     determines what is in `node_modules`, esbuild determines resolution
//     semantics, and the builder source is where the wrapper text is written;
//   - every file in the record's read-set still stats to the same
//     `[mtimeMs, size]`. That is what makes a hand-edited `node_modules`, a
//     `bun link`, or a patched package fall out of the cache.
//
// The read-set is CAPTURED, not guessed (see `ReadSet` in `vendors.ts`), and it
// holds only positive reads. The one thing stat validation structurally cannot
// see is a NEGATIVE probe turning positive — a nearer copy of a package
// appearing where esbuild previously found nothing. That is the gate's job.
//
// Same load/save idiom as the fingerprint cache in `store.ts`: unparseable or
// wrong-version ⇒ treat as empty, atomic tmp-then-rename publish.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  appPathParent,
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename } from "node:path";
import * as esbuild from "esbuild";
import { sha256Hex } from "../hash";
import { WEB_ARTIFACTS_DIR } from "./store";

const VENDOR_RESOLUTIONS_DIR = joinAppPath(
  WEB_ARTIFACTS_DIR,
  "vendor-resolutions",
);

const VENDOR_CACHE_VERSION = 1;

export interface VendorResolutionRecord {
  entryFile: string;
  version: string;
  cjs: boolean;
  wrapper: string;
  /** Exactly the files this resolution read: abs path → [mtimeMs, size]. */
  files: Record<string, [number, number]>;
}

export interface VendorResolutionCache {
  version: number;
  /** Invalidates everything at once when the install or the resolver moves. */
  gate: string;
  /** Key: `${resolveDir}\0${specifier}`. */
  records: Record<string, VendorResolutionRecord>;
}

/** The cache key of one request. `\0` cannot occur in either component. */
export function vendorCacheKey(resolveDir: AppPath, specifier: string): string {
  return `${resolveDir}\0${specifier}`;
}

/** The per-worktree cache file, alongside the vendor sets in the same data dir. */
export function vendorCacheFile(root: AppPath): AppPath {
  return joinAppPath(VENDOR_RESOLUTIONS_DIR, `${basename(root)}.json`);
}

const gateMemo = new Map<string, string>();

/**
 * The whole-cache invalidator. Read once per process (a build-time CLI process,
 * so the lockfile cannot move underneath it).
 */
export function computeVendorCacheGate(opts: {
  root: AppPath;
  builderVersion: number;
  /** Builder own-source digest — the wrapper text is written in that source. */
  builderSource: string;
}): string {
  const memoKey = `${opts.root}\0${opts.builderVersion}\0${opts.builderSource}`;
  const memoized = gateMemo.get(memoKey);
  if (memoized !== undefined) return memoized;

  const lockFile = joinAppPath(opts.root, "bun.lock");
  let lock: string;
  try {
    lock = readFileSync(lockFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Degrading to "no gate" would silently serve resolutions from an install
    // nothing is watching any more — a missing lockfile is a broken checkout.
    throw new Error(
      `vendor cache: ${lockFile} is missing — the lockfile is what invalidates ` +
        `resolutions when the install moves.`,
      { cause: err },
    );
  }
  const gate = sha256Hex(
    JSON.stringify({
      lock,
      esbuild: esbuild.version,
      v: opts.builderVersion,
      src: opts.builderSource,
    }),
  );
  gateMemo.set(memoKey, gate);
  return gate;
}

function emptyCache(gate: string): VendorResolutionCache {
  return { version: VENDOR_CACHE_VERSION, gate, records: {} };
}

/**
 * Load the cache for `gate`. A cache written under a different gate is dropped
 * wholesale — that IS the install/resolver invalidation.
 */
export function loadVendorResolutionCache(
  file: AppPath,
  gate: string,
): VendorResolutionCache {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return emptyCache(gate);
  }
  let parsed: VendorResolutionCache;
  try {
    parsed = JSON.parse(raw) as VendorResolutionCache;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return emptyCache(gate);
  }
  if (
    parsed.version !== VENDOR_CACHE_VERSION ||
    typeof parsed.records !== "object" ||
    parsed.gate !== gate
  ) {
    return emptyCache(gate);
  }
  return parsed;
}

export function saveVendorResolutionCache(
  file: AppPath,
  cache: VendorResolutionCache,
): void {
  mkdirSync(appPathParent(file), { recursive: true });
  const tmp = joinAppPath(
    appPathParent(file),
    `${basename(file)}.${process.pid}.tmp`,
  );
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}

/**
 * True iff every file the resolution read still stats to the recorded
 * `[mtimeMs, size]`. A vanished file is a miss; any other stat error rethrows.
 */
export function validateVendorRecord(record: VendorResolutionRecord): boolean {
  for (const [file, [mtimeMs, size]] of Object.entries(record.files)) {
    let stat: ReturnType<typeof statSync>;
    try {
      // A resolved file path recorded by this app in its own cache file.
      stat = statSync(asAppPath(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return false;
    }
    if (stat.mtimeMs !== mtimeMs || stat.size !== size) return false;
  }
  return true;
}
