// The RUN BASE: the complete per-file lint state a completed type-check run
// ended in, content-addressed, so the next run reads only what changed since.
//
// Without it every run re-verified every file's stored state — 12.6k per-file
// lint entries read and parsed in prepare, a job per file sent to the worker,
// and a verdict assembled over every file in finalize — O(repo) on a tree
// where one file moved (research/2026-10-21-global-type-check-prepare-follows-the-change.md,
// Stage B).
//
// A base is a function of its tree and its global inputs, not of a worktree,
// so it is host-wide:
//
//   - the ROOT, one per checked tree (pointer `tree → root hash`), holds the
//     global inputs its state is valid under — every syntactic group's
//     fingerprint, every typed part's, the directive (`LINT_GROUP_ALL`) one,
//     and the overlay — plus, per SHARD id, the shard's content hash, the hash
//     of its listing (each lintable file's path and version), whether it holds
//     any message, and the day it was last marked used;
//   - a SHARD is the files of one leaf plugin (`shardOf`), each with its
//     version, directive flag, result key R (what keys its typed parts,
//     `./name-walk.ts`) and its non-empty raw messages per part — keyed by its
//     content hash, so nearby trees share every shard they agree on and a run
//     writes only the shards whose state it changed.
//
// A file's state in a base is COMPLETE under the root's inputs: each syntactic
// group's result under the root's fingerprint for it, each typed part's under
// `typedResultKey(typed fp, R)`, a directive file's whole result under
// `typedResultKey(all fp, R)`. So a later run whose inputs equal the root's
// carries every file whose version did not move, and asks only the worker —
// which alone knows R — whether a carried file's key moved.
//
// Correctness never rests on WHICH base a run picks: a shard is carried only
// when its listing hash (computed from the current tree) equals the root's, a
// file only when its version does, and the global inputs are compared. Picking
// a base is a matter of how much is left to do, never of what the verdict is.
//
// The ROOT's directory is bounded tighter than the shards' (one root per
// distinct tree), and a root that carries a shard last marked used more than
// `TOUCH_AFTER_DAYS` ago touches it — so every shard outlives every root that
// names it (`ROOT_BOUNDS.maxAgeMs` + `TOUCH_AFTER_DAYS` < `SHARD_BOUNDS.maxAgeMs`).
// A shard missing anyway (the count backstop, a hand deletion) is found
// before the base is used and the run takes the full path, saying why.

import { z } from "zod";
import type { RawLintMessage } from "../core";
import { runBaseRootsDir, runBaseShardsDir } from "../data-dirs";
import { sha256 } from "./keys";
import { messageSchema } from "./lint-results";
import { openPassSet, type PassSetBounds } from "./pass-set";

/** Bump when the meaning of a stored root or shard changes (its key would not). */
export const RUN_BASE_FORMAT = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A carried shard last marked used this many days ago is touched again. */
export const TOUCH_AFTER_DAYS = 3;

const ROOT_BOUNDS: PassSetBounds = {
  maxAgeMs: 7 * DAY_MS,
  maxEntries: 3000,
  trimTo: 2400,
  pruneIntervalMs: 60 * 60 * 1000,
};

const SHARD_BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * DAY_MS,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

/** One file's lint state in a base. Optional fields are absent when empty. */
export const fileBaseSchema = z.object({
  /** The file's version: its git blob sha. */
  v: z.string(),
  /** Present (1) when the text carries an eslint directive: one unit, `LINT_GROUP_ALL`. */
  d: z.literal(1).optional(),
  /** The file's result key R, which keys its typed parts. */
  r: z.string(),
  /** Non-empty syntactic results, by group. */
  s: z.record(z.array(messageSchema)).optional(),
  /** Non-empty typed results, by group (`LINT_GROUP_ALL` for a directive file). */
  t: z.record(z.array(messageSchema)).optional(),
});

export type FileBase = z.infer<typeof fileBaseSchema>;

const shardSchema = z.object({ files: z.record(fileBaseSchema) });

export interface RunBaseShard {
  files: Record<string, FileBase>;
}

/** The lint inputs a base's state is valid under. */
export interface RunBaseLint {
  /** Each syntactic group's fingerprint. */
  fps: Record<string, string>;
  /** Each typed part's fingerprint (the groups holding a type-aware rule). */
  typed: Record<string, string>;
  /** A directive file's whole-result fingerprint. */
  allFp: string;
}

/** A shard's line in a root: [content hash, listing hash, holds messages, day last marked used]. */
export type ShardRef = [string, string, 0 | 1, number];

const rootSchema = z.object({
  format: z.literal(RUN_BASE_FORMAT),
  treeHash: z.string(),
  lint: z.object({
    fps: z.record(z.string()),
    typed: z.record(z.string()),
    allFp: z.string(),
  }),
  overlay: z.record(z.string()),
  walk: z.string().optional(),
  shards: z.record(
    z.tuple([
      z.string(),
      z.string(),
      z.union([z.literal(0), z.literal(1)]),
      z.number(),
    ]),
  ),
});

export interface RunBaseRoot {
  format: typeof RUN_BASE_FORMAT;
  /** The tree it was recorded on. */
  treeHash: string;
  lint: RunBaseLint;
  /** The overlay it was checked with (gitignored program roots → blob sha). */
  overlay: Record<string, string>;
  /**
   * The walk base the same run ended in (`./walk-base.ts`, its root's hash),
   * when its worker wrote one: what the next run's walk starts from, so every
   * file it does not visit keeps the key this base holds.
   */
  walk?: string;
  shards: Record<string, ShardRef>;
}

/** Today, as the day number a root records a shard's use under. */
export const dayNumber = (now = Date.now()): number => Math.floor(now / DAY_MS);

/**
 * The shard a repo file belongs to: its deepest `plugins/<name>` directory
 * (a leaf plugin, ~8 lintable files), else its top-level directory, else ""
 * for a root file.
 */
export function shardOf(path: string): string {
  const parts = path.split("/");
  let end = 0;
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === "plugins") end = i + 2;
  }
  if (end > 0) return parts.slice(0, end).join("/");
  return parts.length > 1 ? parts[0]! : "";
}

const short = (s: string): string => sha256(s).slice(0, 24);

/**
 * A shard's listing: its lintable files and their versions, as one hash —
 * computed from the current tree with no read, and compared with a root's to
 * decide whether that shard's state carries.
 */
export function listingHash(
  files: readonly (readonly [string, string])[],
): string {
  return short(
    [...files]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([p, v]) => `${p}\0${v}`)
      .join("\n"),
  );
}

const sortedRecord = <T>(
  r: Record<string, T> | undefined,
): Record<string, T> | undefined => {
  if (r === undefined) return undefined;
  const keys = Object.keys(r).sort();
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.map((k) => [k, r[k]!]));
};

/**
 * One file's state, canonical: empty parts dropped, keys sorted — so a shard's
 * content hash is a function of the state, not of the order it was built in.
 */
export function fileBase(
  version: string,
  directive: boolean,
  r: string,
  s: Record<string, readonly RawLintMessage[]>,
  t: Record<string, readonly RawLintMessage[]>,
): FileBase {
  const nonEmpty = (x: Record<string, readonly RawLintMessage[]>) =>
    sortedRecord(
      Object.fromEntries(
        Object.entries(x)
          .filter(([, m]) => m.length > 0)
          .map(([k, m]) => [k, [...m]]),
      ),
    );
  const out: FileBase = { v: version, r };
  if (directive) out.d = 1;
  const ss = nonEmpty(s);
  if (ss !== undefined) out.s = ss;
  const tt = nonEmpty(t);
  if (tt !== undefined) out.t = tt;
  return out;
}

/** Whether a file's state holds any message. */
export const hasMessages = (f: FileBase): boolean =>
  f.s !== undefined || f.t !== undefined;

/** Every message of a file's state, in reading order (line, then column). */
export function messagesOf(f: FileBase): RawLintMessage[] {
  const all = [
    ...Object.values(f.s ?? {}).flat(),
    ...Object.values(f.t ?? {}).flat(),
  ];
  return all.sort((a, b) => a.line - b.line || a.column - b.column);
}

function canonicalShard(shard: RunBaseShard): RunBaseShard {
  return { files: sortedRecord(shard.files) ?? {} };
}

/** A shard's content hash: its key in the store. */
export const shardHash = (shard: RunBaseShard): string =>
  short(JSON.stringify(canonicalShard(shard)));

function canonicalRoot(root: RunBaseRoot): RunBaseRoot {
  return {
    format: root.format,
    treeHash: root.treeHash,
    lint: {
      fps: sortedRecord(root.lint.fps) ?? {},
      typed: sortedRecord(root.lint.typed) ?? {},
      allFp: root.lint.allFp,
    },
    overlay: sortedRecord(root.overlay) ?? {},
    ...(root.walk === undefined ? {} : { walk: root.walk }),
    shards: sortedRecord(root.shards) ?? {},
  };
}

/** A root's content hash: its key in the store. */
export const rootHash = (root: RunBaseRoot): string =>
  short(JSON.stringify(canonicalRoot(root)));

/** Whether a base's lint inputs are the run's: then every carried file's state stands. */
export function sameLintInputs(a: RunBaseLint, b: RunBaseLint): boolean {
  const same = (x: Record<string, string>, y: Record<string, string>) => {
    const kx = Object.keys(x);
    return (
      kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k])
    );
  };
  return a.allFp === b.allFp && same(a.fps, b.fps) && same(a.typed, b.typed);
}

/** What a put did: the entry's content hash, and whether it had to be written. */
export interface Stored {
  hash: string;
  wrote: boolean;
}

export interface RunBaseStore {
  /** The root hash recorded for a tree, if any. */
  pointer(treeHash: string): string | undefined;
  setPointer(treeHash: string, root: string): void;
  /** A root by its hash, or undefined when it is not (or no longer) stored. */
  root(hash: string): RunBaseRoot | undefined;
  /** Store a root (or mark the stored copy used): its hash, and whether it was new. */
  putRoot(root: RunBaseRoot): Stored;
  hasShard(hash: string): boolean;
  shard(hash: string): RunBaseShard | undefined;
  /** Store a shard (or mark the stored copy used): its hash, and whether it was new. */
  putShard(shard: RunBaseShard): Stored;
  /** Mark a stored shard used now. False when it is not stored. */
  touchShard(hash: string): boolean;
  /** The tree this worktree's last completed run checked: a hint, never trusted. */
  hint(worktree: string): string | undefined;
  setHint(worktree: string, treeHash: string): void;
}

const pointerSchema = z.object({ root: z.string() });
const hintSchema = z.object({ treeHash: z.string() });

/** Open (and lazily create) the host-wide run base store. */
export function openRunBaseStore(): RunBaseStore {
  const roots = openPassSet(runBaseRootsDir, ROOT_BOUNDS);
  const shards = openPassSet(runBaseShardsDir, SHARD_BOUNDS);
  // NUL never occurs in a hash or a path, so the kinds of key cannot meet.
  const pointerKey = (t: string) => `tree\0${RUN_BASE_FORMAT}\0${t}`;
  const rootKey = (h: string) => `root\0${RUN_BASE_FORMAT}\0${h}`;
  const shardKey = (h: string) => `shard\0${RUN_BASE_FORMAT}\0${h}`;
  const hintKey = (w: string) => `hint\0${w}`;
  // Every entry is written below and renamed into place whole, so a shape a
  // schema rejects is a bug in this file — surfaced, not skipped.
  return {
    pointer(t) {
      const raw = roots.read(pointerKey(t));
      return raw === undefined ? undefined : pointerSchema.parse(raw).root;
    },
    setPointer(t, root) {
      roots.record(pointerKey(t), { root });
    },
    root(h) {
      const raw = roots.read(rootKey(h));
      return raw === undefined ? undefined : rootSchema.parse(raw);
    },
    putRoot(root) {
      const h = rootHash(root);
      if (roots.touch(rootKey(h))) return { hash: h, wrote: false };
      roots.record(rootKey(h), { ...canonicalRoot(root) });
      return { hash: h, wrote: true };
    },
    hasShard(h) {
      return shards.has(shardKey(h));
    },
    shard(h) {
      const raw = shards.read(shardKey(h));
      return raw === undefined ? undefined : shardSchema.parse(raw);
    },
    putShard(shard) {
      const h = shardHash(shard);
      if (shards.touch(shardKey(h))) return { hash: h, wrote: false };
      shards.record(shardKey(h), { ...canonicalShard(shard) });
      return { hash: h, wrote: true };
    },
    touchShard(h) {
      return shards.touch(shardKey(h));
    },
    hint(w) {
      const raw = roots.read(hintKey(w));
      return raw === undefined ? undefined : hintSchema.parse(raw).treeHash;
    },
    setHint(w, treeHash) {
      roots.record(hintKey(w), { treeHash });
    },
  };
}

/**
 * Every file of a base, read whole: what the worker compares each carried
 * file's result key against. Throws when the root or a shard it names is not
 * stored — the preparation checked that every one was, so a gap here is a
 * store pruned under a running check, and a verdict over a partial base would
 * be silently wrong.
 */
export function loadRunBaseFiles(
  store: RunBaseStore,
  hash: string,
): Map<string, FileBase> {
  const root = store.root(hash);
  if (root === undefined) {
    throw new Error(
      `type-check: the run base ${hash} is not stored (pruned under a running check?)`,
    );
  }
  const files = new Map<string, FileBase>();
  for (const [id, [h]] of Object.entries(root.shards)) {
    const shard = store.shard(h);
    if (shard === undefined) {
      throw new Error(
        `type-check: the run base ${hash}'s shard ${id} (${h}) is not stored (pruned under a running check?)`,
      );
    }
    for (const [p, f] of Object.entries(shard.files)) files.set(p, f);
  }
  return files;
}

/** A base's files, read shard by shard as they are asked for. */
export interface RunBaseLookup {
  get(path: string): FileBase | undefined;
  /** How many shards were read. */
  readonly shardsRead: number;
}

/**
 * A base's files, each shard read the first time one of its files is asked
 * for: what the worker compares a walked file's result key against — only
 * the files the walk visited can have a key other than the base's. Throws,
 * like `loadRunBaseFiles`, when the root or a shard it names is gone.
 */
export function runBaseLookup(
  store: RunBaseStore,
  hash: string,
): RunBaseLookup {
  const root = store.root(hash);
  if (root === undefined) {
    throw new Error(
      `type-check: the run base ${hash} is not stored (pruned under a running check?)`,
    );
  }
  const shards = new Map<string, Record<string, FileBase>>();
  return {
    get(path) {
      const id = shardOf(path);
      let files = shards.get(id);
      if (files === undefined) {
        const ref = root.shards[id];
        if (ref === undefined) files = {};
        else {
          const shard = store.shard(ref[0]);
          if (shard === undefined) {
            throw new Error(
              `type-check: the run base ${hash}'s shard ${id} (${ref[0]}) is not stored (pruned under a running check?)`,
            );
          }
          files = shard.files;
        }
        shards.set(id, files);
      }
      return files[path];
    },
    get shardsRead() {
      return shards.size;
    },
  };
}
