import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import {
  exists,
  readFile,
  readdir,
} from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import {
  type AppPath,
  appPathParent,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Syncing a release bundle's resolved config origins onto a host's config dir.
 *
 * Split out of `boot.ts` so it can be tested on nothing but a temp directory:
 * this module reaches `node:fs`/`node:path`/`node:crypto` and nothing else, so a
 * test never drags in the gateway, the DB or the paths runtime. `boot.ts` owns
 * the one thing that IS environment — which two directories these are.
 */

/**
 * The `// @hash <digest>` header every propagated config document carries on
 * line 1. Spelled here rather than imported to keep the launcher's import
 * closure small: it boots a released app with no repo around it, so it must not
 * pull in the `config_v2` barrels (which reach `fields/core` → React) — the same
 * intent that makes `@plugins/config_v2/data-dirs` the one config_v2 module the
 * launcher may reach. The header grammar is an on-disk contract, identical in
 * both layers.
 *
 * That closure used to be enforced by a `tools` tsconfig whose `lib` withheld
 * DOM, so a React type reaching here was a compile error. The repo builds one
 * full-lib program now, so nothing fails if the closure grows — keep it small on
 * purpose (research/2026-09-18-global-type-check-one-program.md).
 */
const HASH_HEADER_RE = /^\/\/ @hash ([a-f0-9]+)\n/;

/** The build-owned layer. Everything else under a config dir is the user's. */
const ORIGIN_SUFFIX = ".origin.jsonc";
/** The transient three-way-merge base, captured at the conflict transition. */
const ANCESTOR_SUFFIX = ".ancestor.jsonc";

/**
 * The `// @hash` header of a config file, or null when the file is absent or
 * carries no readable header. Null is a real answer here, not a swallowed error:
 * the header is only ever consulted to decide whether to capture an ancestor
 * snapshot, so an unreadable one costs the settings UI its three-way Merge and
 * nothing else — the origin is still refreshed and the override still stands.
 * Refusing to boot a deployed app over a corrupt USER file would trade a
 * cosmetic loss for a downed site.
 */
async function hashHeaderOf(filePath: AppPath): Promise<string | null> {
  if (!(await exists(filePath))) return null;
  return HASH_HEADER_RE.exec(await readFile(filePath, "utf-8"))?.[1] ?? null;
}

/** Replace `filePath`'s bytes atomically, creating its directory. */
async function writeFileAtomic(
  filePath: AppPath,
  bytes: string,
): Promise<void> {
  const tmp = joinAppPath(
    appPathParent(filePath),
    `${basename(filePath)}.tmp-${randomUUID()}`,
  );
  await mkdir(asAppPath(dirname(filePath)), { recursive: true });
  try {
    await writeFile(tmp, bytes, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch (unlinkErr: unknown) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
        throw unlinkErr;
    }
    throw err;
  }
}

/** Every `*.origin.jsonc` under `dir`, as forward-slash paths relative to it. */
async function listOriginFiles(dir: AppPath, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(joinAppPath(dir, rel), {
    withFileTypes: true,
  })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      out.push(...(await listOriginFiles(dir, childRel)));
    else if (entry.name.endsWith(ORIGIN_SUFFIX)) out.push(childRel);
  }
  return out;
}

/** Drop directories left empty by the prune, deepest first. */
async function removeEmptyDirsUnder(dir: AppPath): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = joinAppPath(dir, entry.name);
    await removeEmptyDirsUnder(child);
    if ((await readdir(child)).length === 0) await rmdir(child);
  }
}

/**
 * Bring `destDir`'s build-owned config layer in line with `srcDir`'s, and touch
 * nothing else.
 *
 * **Only the origin layer moves.** config_v2's three-layer model already says
 * who owns what: `<name>.origin.jsonc` is propagated (build-owned, rewritten
 * every build) and `<name>.jsonc` is the user's own override (never clobbered).
 * The release path used to collapse both into a single directory-level
 * copy-if-absent, so a data dir that survived one deploy froze the entire config
 * layer at whatever the FIRST bundle installed. Every config committed after
 * that shipped inside the bundle and was then ignored, silently: a per-app scope
 * that never materialized reads as "no scope", and a reorder directive naming a
 * contribution that no longer exists just falls back to load order. Nothing
 * fails; the deployed app is merely a different app than the one that was built.
 *
 * The write rule mirrors `propagate()` (config_v2's `tier-logic`) exactly,
 * including its ancestor snapshot: an override still in sync with the origin on
 * disk that this bundle's origin would make stale gets that old origin preserved
 * beside it as `<name>.ancestor.jsonc`, so the settings UI can still offer a
 * three-way Merge. Each seed file was itself written BY `propagate` — its
 * `// @hash` is the hash of its own body — so copying it verbatim is byte-for-byte
 * what `propagate` would write here, and comparing the two headers is exactly its
 * staleness predicate. No hashing and no precedence rule is re-implemented:
 * resolution happened at build time, where the dev toolchain is.
 *
 * An origin `srcDir` does not carry is removed, so that a per-app scope deleted
 * from version control reverts to base instead of living onforever — the mirror
 * image of the bug above. With ONE exception, taken verbatim from
 * `propagateConfigToUser`: an origin with a sibling `<name>.jsonc` is a runtime
 * user fork, whose origin the app itself wrote when the user first customized
 * that scope. That is per-user state, not stale propagation, and deleting it
 * would strand the override beside it. User-owned files are themselves never
 * removed, so a directory still holding one survives.
 *
 * Returns what it did, for the caller's boot log.
 */
export async function propagateOriginLayer(
  srcDir: AppPath,
  destDir: AppPath,
): Promise<{ written: number; removed: number }> {
  const shipped = new Set(await listOriginFiles(srcDir));
  let written = 0;

  for (const rel of shipped) {
    const segments = rel.split("/");
    const from = joinAppPath(srcDir, ...segments);
    const to = joinAppPath(destDir, ...segments);
    const bytes = await readFile(from, "utf-8");
    if ((await exists(to)) && (await readFile(to, "utf-8")) === bytes) continue;

    // Snapshot the merge base BEFORE overwriting, at the same transition
    // `propagate()` captures: the override is still in sync with the origin on
    // disk (`oldOrigin.hash === override.hash`) and this bundle's origin will
    // make it stale (`override.hash !== newHash`). Idempotent for the reason it
    // is there — once the override is stale the hashes differ, so a later boot
    // never clobbers the true base with an intermediate origin.
    const stem = basename(to, ORIGIN_SUFFIX);
    const overrideHash = await hashHeaderOf(
      joinAppPath(asAppPath(dirname(to)), `${stem}.jsonc`),
    );
    const oldOriginHash = await hashHeaderOf(to);
    const newHash = HASH_HEADER_RE.exec(bytes)?.[1] ?? null;
    if (
      overrideHash !== null &&
      oldOriginHash === overrideHash &&
      overrideHash !== newHash
    ) {
      await writeFileAtomic(
        joinAppPath(asAppPath(dirname(to)), `${stem}${ANCESTOR_SUFFIX}`),
        await readFile(to, "utf-8"),
      );
    }

    await writeFileAtomic(to, bytes);
    written++;
  }

  let removed = 0;
  if (await exists(destDir)) {
    for (const rel of await listOriginFiles(destDir)) {
      if (shipped.has(rel)) continue;
      const path = joinAppPath(destDir, ...rel.split("/"));
      // A runtime fork keeps its origin — see the note above.
      if (
        await exists(
          joinAppPath(
            asAppPath(dirname(path)),
            `${basename(path, ORIGIN_SUFFIX)}.jsonc`,
          ),
        )
      )
        continue;
      await unlink(path);
      removed++;
    }
    await removeEmptyDirsUnder(destDir);
  }

  return { written, removed };
}
