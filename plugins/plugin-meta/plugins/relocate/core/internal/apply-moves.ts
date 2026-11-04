// Replays the plugin-move ledger onto one namespace's USER-layer config dir
// (`~/.equin/state/config/<namespace>/`). Run by `./equin build`
// right before it propagates the git config into that dir, so the dir is
// already shaped like the code being deployed when propagation reads it.
//
// A plugin's config lives under its id's slash path, and saved reorder layouts
// name contributions `"<pluginId>:<id>"` in ANY slot's file. A move changes
// both. For each entry this namespace has not applied yet:
//
//   1. every file under `<from path>/` moves to the same spot under `<to path>/`
//      — a file already at the destination wins and the source stays put (the
//      orphan audit then flags it). Nothing is overwritten or deleted.
//   2. every reorder key naming the moved plugin (or a descendant) is rewritten,
//      in every `.jsonc` of the namespace — found by the same locator the mover
//      uses on the git layer (`scanReorderItemRefs`).
//   3. hash headers are kept consistent. An override records the hash of the
//      default it was written against; rewriting that default's keys changes
//      its hash, which would mark the override stale and let the default win —
//      the very loss this prevents. So every rewritten origin/ancestor yields an
//      old → new hash pair, and each override's header is re-stamped through it.
//      A rewritten ORIGIN is stamped with the hash of the document propagation
//      is about to write there (the checkout's git layer) when the two are the
//      same document but for order — a renamed key re-sorts in a regenerated
//      catalog, and the text's own hash would then disagree with propagation's
//      and turn the re-stamped override into a conflict anyway.
//
// Each applied entry is recorded in the namespace's marker file, so an entry is
// replayed once — even if a later plugin reuses the old id. A namespace whose
// dir does not exist yet records every entry as applied: it has nothing to move.
// The ledger mechanics (marker, fresh namespace, hash re-stamping) are the
// shared config ledger's (`config_v2/plugins/ledger`), which config
// migrations ride too.

import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  appPathParent,
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  committedDocument,
  committedFilesIn,
  computeHash,
  parseConfigFileRelPath,
  scopeAppId,
  type CommittedFiles,
  type JsonValue,
} from "@plugins/config_v2/core";
import { asPath } from "@plugins/framework/plugins/plugin-id/core";
import { scanReorderItemRefs } from "@plugins/plugin-meta/plugins/plugin-refs/core";
import {
  rewriteConfigFiles,
  runConfigLedger,
  walkConfigFiles,
} from "@plugins/config_v2/plugins/ledger/core";
import {
  movedPluginId,
  pluginMoveKey,
  readPluginMoves,
  type PluginMove,
} from "./ledger";
import { sameDocumentModuloOrder } from "./same-document";

/** Per-namespace record of the ledger entries already applied. Not `.jsonc`,
 *  so neither the config registry nor the orphan audit ever reads it. */
export const APPLIED_MOVES_FILE = ".plugin-moves-applied.json";

export interface AppliedMove {
  move: PluginMove;
  /** Files moved from the old slash path to the new one (dir-relative). */
  moved: string[];
  /** Files left at the old path because the destination already had one. */
  kept: string[];
  /** Files whose reorder keys or hash header were rewritten. */
  rewritten: string[];
}

/** Remove every empty dir under (and including) `dir`, deepest first. */
function pruneEmptyDirs(dir: AppPath): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(joinAppPath(dir, e.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

function moveTree(
  src: AppPath,
  dst: AppPath,
): { moved: string[]; kept: string[] } {
  const moved: string[] = [];
  const kept: string[] = [];
  if (!existsSync(src)) return { moved, kept };
  for (const rel of walkConfigFiles(src)) {
    const to = joinAppPath(dst, rel);
    if (existsSync(to)) {
      kept.push(rel);
      continue;
    }
    mkdirSync(appPathParent(to), { recursive: true });
    renameSync(joinAppPath(src, rel), to);
    moved.push(rel);
  }
  pruneEmptyDirs(src);
  return { moved, kept };
}

/** `text` with every reorder key naming the moved subtree re-rooted. */
export function rewriteKeys(
  file: string,
  text: string,
  move: PluginMove,
): string {
  const edits = scanReorderItemRefs(file, text)
    .map((ref) => ({ ref, to: movedPluginId(ref.id, move.from, move.to) }))
    .filter((e) => e.to !== null)
    .sort((a, b) => b.ref.range.start - a.ref.range.start);
  let out = text;
  for (const { ref, to } of edits) {
    out = out.slice(0, ref.range.start) + to + out.slice(ref.range.end);
  }
  return out;
}

/**
 * The hash a re-rooted user snapshot is stamped with: for an origin that is the
 * git-layer document propagation writes next but for order, that document's
 * hash (what propagation will stamp); otherwise its own content's.
 */
function upstreamAwareHash(
  files: CommittedFiles,
): (rel: string, content: JsonValue) => string {
  return (rel, content) => {
    const ref = parseConfigFileRelPath(rel);
    if (ref.file !== "origin") return computeHash(content);
    const doc = committedDocument(ref.storePath, files);
    const appId = scopeAppId(ref.scopeId);
    const upstream =
      doc === undefined
        ? undefined
        : appId === undefined
          ? doc.base
          : doc.scopes[appId];
    return upstream !== undefined && sameDocumentModuloOrder(content, upstream)
      ? computeHash(upstream)
      : computeHash(content);
  };
}

/**
 * Apply every ledger entry of the checkout at `root` that the namespace config
 * dir `userConfigDir` has not applied yet, in ledger order. Throws (failing the
 * build) on anything unreadable; the marker is written after each entry, so a
 * rerun resumes where it stopped.
 */
export function applyPluginMoves(opts: {
  root: AppPath;
  userConfigDir: AppPath;
}): AppliedMove[] {
  const { root, userConfigDir } = opts;
  // The committed layer the build's propagation reads.
  const committed = committedFilesIn(joinAppPath(root, "config"), {
    existsSync,
    readFileSync,
    readdirSync,
  });
  return runConfigLedger({
    userConfigDir,
    markerFile: APPLIED_MOVES_FILE,
    fresh: !existsSync(userConfigDir),
    entries: readPluginMoves(root).map((move) => ({
      key: pluginMoveKey(move),
      apply: (dir): AppliedMove => {
        const { moved, kept } = moveTree(
          joinAppPath(userConfigDir, asPath(move.from)),
          joinAppPath(userConfigDir, asPath(move.to)),
        );
        const rewritten = rewriteConfigFiles(dir, {
          rewrite: (f, text) => rewriteKeys(f, text, move),
          snapshotHash: upstreamAwareHash(committed),
        });
        return { move, moved, kept, rewritten };
      },
    })),
  }).map(({ result }) => result);
}

/** Namespaces under `configRoot` with user config still at `from`'s slash path. */
export function namespacesHolding(
  configRoot: AppPath,
  from: PluginMove["from"],
): string[] {
  if (!existsSync(configRoot)) return [];
  return readdirSync(configRoot)
    .filter((ns) => existsSync(joinAppPath(configRoot, ns, asPath(from))))
    .sort();
}
