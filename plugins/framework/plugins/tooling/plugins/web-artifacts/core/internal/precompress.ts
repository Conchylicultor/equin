// Precompressed sidecars: `<file>.br` and `<file>.gz` written beside every
// compressible file of a dir about to be published. Everything a dist serves is
// write-once (content-addressed artifacts, vendor sets, the global-CSS cache),
// so its bytes are compressed exactly once, here — and the gateway only negotiates (`gateway/proxy.go`
// `serveStaticFile`), never compresses a file per request.

import { readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/**
 * Extensions worth compressing: text and the uncompressed binaries a browser
 * host ships (PGlite's wasm and data). Already-compressed formats (woff2,
 * png, …) are absent on purpose. Source maps too: only DevTools fetches them,
 * and the vendor set alone carries tens of MB of them.
 */
const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".wasm",
  ".data",
  ".svg",
  ".html",
  ".txt",
  ".webmanifest",
]);

/** Below this a sidecar costs a file for a saving lost in the headers. */
const MIN_BYTES = 1024;
/** A sidecar must save at least this fraction, or it is not written. */
const MIN_SAVING = 0.05;
/**
 * Brotli quality. Measured over a whole dist's modules (2022 files, 39 MB):
 * q9 takes 6 s and q11 194 s for a body only 6 % smaller (PGlite's 10.5 MB
 * wasm alone: 5 s vs 95 s). A full fleet rebuild publishes every one of them,
 * so q11 would more than double it.
 */
const BROTLI_QUALITY = 9;

// One gate for the whole process: the pipeline publishes many artifacts at
// once, and each compression runs on the zlib threadpool.
const gate = createSemaphore(Math.max(1, availableParallelism() - 1));

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

/** True iff `name` is a file the build writes sidecars for. */
export function isCompressible(name: string): boolean {
  return COMPRESSIBLE.has(extOf(name));
}

async function compressFile(file: string): Promise<void> {
  const bytes = await readFile(file);
  const [br, gzipped] = await Promise.all([
    brotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
    gz(bytes, { level: 9 }),
  ]);
  const limit = bytes.length * (1 - MIN_SAVING);
  if (br.length <= limit) await writeFile(`${file}.br`, br);
  if (gzipped.length <= limit) await writeFile(`${file}.gz`, gzipped);
}

/**
 * Write `.br` / `.gz` sidecars for every compressible file among `files`. Run
 * on files before they become visible — a store tmp dir before its rename, a
 * staging dist before its swap — so no reader ever sees one without them.
 */
export async function precompressFiles(files: string[]): Promise<void> {
  const due = files.filter(
    (f) => isCompressible(f) && statSync(f).size >= MIN_BYTES,
  );
  await Promise.all(due.map((f) => gate.run(() => compressFile(f))));
}

/** {@link precompressFiles} over every file under `dir`, recursively. */
export async function precompressDir(dir: string): Promise<void> {
  const files: string[] = [];
  for (const dirent of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (dirent.isFile()) files.push(join(dirent.parentPath, dirent.name));
  }
  await precompressFiles(files);
}
