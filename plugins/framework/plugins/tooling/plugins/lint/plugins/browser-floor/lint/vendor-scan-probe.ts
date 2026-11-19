// The `browser-floor:vendor-sets` probe: holds every vendor set in the host's
// web-artifact store — the npm code a page and a browser host's worker load
// (the worker tree's `_vendor/` IS the set), as esbuild bundled it — to the
// floor's regular expressions (`vendor-scan.ts`). A subprocess because
// parsing a set (~30 MB of minified JS) is seconds of synchronous work the
// check runner's shared thread must not hold.
//
// Memoized, so it works only when a set is new. A set is write-once and
// content-addressed, so its verdict is kept in `<memoDir>/<set>.json` under the
// scanner's digest (this folder's verdict code, and the versions of the
// compat data, regexpp and TypeScript it reads with); a memo whose set is gone
// from the store is deleted. A new set's files are matched by content hash
// against every kept memo first: most sets differ from the last only in a few
// chunks (a set's address also moves with web-artifacts' own source).
//
// Spawned by `../check/index.ts` — a script, not check code: it sits beside
// the verdict it runs (a leaf folder is never imported from another folder),
// and is never imported by `./index.ts`.
// Run as: bun vendor-scan-probe.ts
// Stdin: JSON `{ vendorsDir: string; memoDir: string }`.
// Emits JSON: {@link ProbeAnswer}.
import { createRequire } from "node:module";
import * as path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { aboveFloorTable } from "./above-floor";
import {
  npmSourceName,
  scanChunk,
  sourceIndexAt,
  type ChunkHit,
} from "./vendor-scan";

export interface VendorHit extends ChunkHit {
  /** The chunk, relative to its set (`chunks/chunk-AB12.js`). */
  file: string;
  /** Where the chunk's sourcemap says the regex came from (`node_modules/<pkg>/<path>`), or null. */
  source: string | null;
}

export interface SetVerdict {
  /** `set.<hash>`. */
  set: string;
  files: number;
  bytes: number;
  regexes: number;
  /** Files parsed this run (0: the set's memo answered). */
  parsed: number;
  hits: VendorHit[];
}

export interface ProbeAnswer {
  digest: string;
  sets: SetVerdict[];
  /** Memos deleted because their set left the store. */
  dropped: number;
  ms: number;
}

interface FileMemo {
  hash: string;
  bytes: number;
  regexes: number;
  hits: VendorHit[];
}

interface SetMemo {
  digest: string;
  files: Record<string, FileMemo>;
}

const started = performance.now();
const { vendorsDir, memoDir } = JSON.parse(await Bun.stdin.text()) as {
  vendorsDir: string;
  memoDir: string;
};

/**
 * What the verdict is a function of besides a file's bytes: the code of this
 * folder that decides it, and the packages it reads with.
 */
async function scannerDigest(): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of [
    "above-floor.ts",
    "browser-floor.ts",
    "regexp-features.ts",
    "regexp-above-floor.ts",
    "vendor-scan.ts",
    "vendor-scan-probe.ts",
  ]) {
    h.update(`${f}\0`);
    h.update(await Bun.file(path.join(import.meta.dir, f)).arrayBuffer());
  }
  const require = createRequire(import.meta.url);
  for (const pkg of [
    "@mdn/browser-compat-data",
    "@eslint-community/regexpp",
    "typescript",
  ]) {
    const pj = (await Bun.file(
      require.resolve(`${pkg}/package.json`),
    ).json()) as { version: string };
    h.update(`${pkg}@${pj.version}\0`);
  }
  return h.digest("hex").slice(0, 16);
}

async function readMemo(file: string): Promise<SetMemo | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  return (await f.json()) as SetMemo;
}

/** The set's JS files, relative to it: its entries and `chunks/`. */
async function setFiles(dir: string): Promise<string[]> {
  const top = await readdir(dir);
  const chunks = top.includes("chunks")
    ? (await readdir(path.join(dir, "chunks")))
        .filter((f) => f.endsWith(".js"))
        .map((f) => `chunks/${f}`)
    : [];
  return [...top.filter((f) => f.endsWith(".js")), ...chunks].sort();
}

async function sourcesOf(
  file: string,
  hits: readonly ChunkHit[],
): Promise<(string | null)[]> {
  const map = Bun.file(`${file}.map`);
  if (!(await map.exists())) return hits.map(() => null);
  const parsed = (await map.json()) as { sources: string[]; mappings: string };
  return hits.map((h) => {
    const i = sourceIndexAt(parsed.mappings, h.line, h.column);
    const src = i < 0 ? undefined : parsed.sources[i];
    return src === undefined ? null : npmSourceName(src);
  });
}

const digest = await scannerDigest();
const table = aboveFloorTable();
await mkdir(memoDir, { recursive: true });

const sets = (await readdir(vendorsDir))
  .filter((n) => n.startsWith("set."))
  .sort();
const live = new Set(sets);

// Every kept memo of this digest, by file content: what a new set reuses.
const known = new Map<string, FileMemo>();
const memos = new Map<string, SetMemo>();
let dropped = 0;
for (const name of await readdir(memoDir)) {
  if (!name.endsWith(".json")) continue;
  const set = name.slice(0, -".json".length);
  if (!live.has(set)) {
    await rm(path.join(memoDir, name), { force: true });
    dropped++;
    continue;
  }
  const memo = await readMemo(path.join(memoDir, name));
  if (memo === null || memo.digest !== digest) continue;
  memos.set(set, memo);
  for (const f of Object.values(memo.files)) known.set(f.hash, f);
}

/** A set the hourly prune removed while it was read: no longer anyone's. */
function vanished(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

const verdicts: SetVerdict[] = [];
for (const set of sets) {
  const dir = path.join(vendorsDir, set);
  let memo = memos.get(set);
  let parsed = 0;
  if (memo === undefined) {
    const files: Record<string, FileMemo> = {};
    let rels: string[];
    try {
      rels = await setFiles(dir);
    } catch (err) {
      if (vanished(err)) continue;
      throw err;
    }
    let gone = false;
    for (const rel of rels) {
      const abs = path.join(dir, rel);
      let bytes: Uint8Array;
      try {
        bytes = await Bun.file(abs).bytes();
      } catch (err) {
        if (!vanished(err)) throw err;
        gone = true;
        break;
      }
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const reused = known.get(hash);
      if (reused !== undefined) {
        files[rel] = {
          ...reused,
          hits: reused.hits.map((h) => ({ ...h, file: rel })),
        };
        continue;
      }
      parsed++;
      const scan = scanChunk(rel, new TextDecoder().decode(bytes), table);
      const sources = await sourcesOf(abs, scan.hits);
      const entry: FileMemo = {
        hash,
        bytes: bytes.byteLength,
        regexes: scan.regexes,
        hits: scan.hits.map((h, i) => ({
          ...h,
          file: rel,
          source: sources[i] ?? null,
        })),
      };
      files[rel] = entry;
      known.set(hash, entry);
    }
    if (gone) continue;
    memo = { digest, files };
    // Written whole, then renamed: a reader never sees half a memo.
    const out = path.join(memoDir, `${set}.json`);
    const tmp = `${out}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(memo));
    await rename(tmp, out);
  }
  const files = Object.values(memo.files);
  verdicts.push({
    set,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    regexes: files.reduce((n, f) => n + f.regexes, 0),
    parsed,
    hits: files.flatMap((f) => f.hits),
  });
}

const answer: ProbeAnswer = {
  digest,
  sets: verdicts,
  dropped,
  ms: Math.round(performance.now() - started),
};
process.stdout.write(JSON.stringify(answer));
