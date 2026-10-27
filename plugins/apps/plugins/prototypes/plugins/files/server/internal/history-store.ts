import { z } from "zod";
import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import {
  relPath,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  protoIdKind,
  type PrototypeHistory,
  type PrototypeVersion,
} from "../../core";

// The prototype version store's contract — what every host's history provides,
// and what its readers (the history resource, the version-file route, restore,
// the mint, the `checkpoints` job) call through `PrototypeHistoryStore`. (Not `PrototypeHistory`: that is the
// wire shape of one prototype's versions, `core/history.ts`.)
//
// Two providers: the desktop's is one private bare git repo per prototype
// (`machine/internal/history/`, the store the CLI reads too); a browser host's
// is content-addressed snapshots over the same file root
// (`plugins/snapshot-history`). One contract suite (`server/testing`) runs
// against both.
//
// Design: `research/2026-09-11-apps-prototype-version-history.md`.

/** The history dir's name inside the prototypes data dir. */
export const HISTORY_DIR_NAME = "_history";

/**
 * The stamp a provider writes into a prototype's history dir after every
 * version it records: `{ n, sha }` of the newest one. It is the one history
 * file the tree's watch passes (git's own files carry no extension, a
 * snapshot's blobs are not `.json`) — how a version recorded by ANOTHER
 * backend reaches this one's subscribers.
 */
export const LATEST_STAMP_FILE = "latest.json";

/** The stamp's shape: the newest version's position and sha. */
export const LatestStampSchema = z.object({
  n: z.number().int().nonnegative(),
  sha: z.string(),
});

/**
 * One prototype's history dir: `_history/<id>.<format>` — `git` for the
 * desktop's repo, `snapshots` for a browser host's. Named for the prototype,
 * so the watcher can tell whose version a stamp records whatever the format
 * (`tree-path.ts`).
 */
export function historyDirOf(id: string, format: string): RelPath {
  return relPath(HISTORY_DIR_NAME, `${assertPrototypeId(id)}.${format}`);
}

/** The newest-version stamp inside {@link historyDirOf}. */
export function historyStampOf(id: string, format: string): RelPath {
  return relPath(
    HISTORY_DIR_NAME,
    `${assertPrototypeId(id)}.${format}`,
    LATEST_STAMP_FILE,
  );
}

/**
 * Every id becomes a path, so it is checked before it touches storage: a route
 * answers 404 for a name that is not an id before it gets here, so past that a
 * bad id is a caller bug, and the store throws. (A minted id has no `.`, so
 * `<id>.<format>` splits back unambiguously.)
 */
export function assertPrototypeId(id: string): string {
  if (!protoIdKind.is(id)) {
    throw new Error(`not a prototype id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** What a recorded version carries beyond the wire shape — for `prototype log`. */
export interface VersionEntry extends PrototypeVersion {
  /** The version's body: a turn's request and agent summary. `""` when none. */
  body: string;
}

export type EnsureHistoryResult =
  { kind: "created" } | { kind: "exists" } | { kind: "no-such-prototype" };

export interface CheckpointInput {
  kind: "turn" | "manual";
  /** Free text; its first line becomes the subject (≤ 72 chars). */
  subject: string;
  body?: string;
  conversationId?: string;
  messageId?: string;
}

export type CheckpointResult =
  | { kind: "recorded"; version: PrototypeVersion }
  /** Nothing changed, OR a version already carries this `messageId`. */
  | { kind: "unchanged" }
  | { kind: "no-such-prototype" };

export type HistoryRead =
  | { kind: "history"; history: PrototypeHistory; entries: VersionEntry[] }
  | { kind: "no-such-prototype" };

export type VersionFileRead =
  { kind: "found"; bytes: Uint8Array<ArrayBuffer> } | { kind: "not-found" };

export type RestoreResult =
  | { kind: "restored"; version: PrototypeVersion }
  | { kind: "no-such-prototype" }
  | { kind: "unknown-version" };

/**
 * One prototype history per prototype folder of the tree. Every id is checked
 * (`protoIdKind.is`) and every sha and file name validated
 * ({@link isVersionSha}, {@link isFlatFileName}) before it touches storage: a
 * bad argument is a caller bug, and throws.
 */
export interface HistoryStore {
  /**
   * Give the prototype a history if it has none: `v0` is the folder as it is
   * now. Idempotent and race-safe — every backend adopts on boot, and a mint
   * does it for the prototype it just made.
   */
  ensureHistory(id: string): Promise<EnsureHistoryResult>;
  /** {@link ensureHistory} for every minted-id folder in the tree. */
  adoptAll(): Promise<void>;
  /** Record the folder as a new version, if it changed. */
  checkpoint(id: string, input: CheckpointInput): Promise<CheckpointResult>;
  /** Every version, oldest → newest, and whether the folder has moved since. */
  readHistory(id: string): Promise<HistoryRead>;
  /**
   * How many versions each prototype has, keyed by id — read from each
   * history's {@link LATEST_STAMP_FILE} (`n + 1`): one small file read per
   * prototype, so the gallery's whole-list read stays cheap. A history without
   * a stamp (or a prototype without a history) is absent, never `0`; a
   * malformed stamp throws, naming the file.
   */
  readVersionCounts(): Promise<Record<string, number>>;
  /** One file of one version, as bytes. */
  readVersionFile(
    id: string,
    sha: string,
    file: string,
  ): Promise<VersionFileRead>;
  /**
   * Make version `sha` (or an abbreviation naming exactly one) live again:
   * unsaved changes are recorded first (a `manual` "Before restore" version),
   * the old files are written back — and files it did not have are deleted —
   * then a `restore` version records it. Dot-files are never touched.
   */
  restoreVersion(id: string, sha: string): Promise<RestoreResult>;
}

/**
 * Each prototype's version history, on whatever host runs: git repos on the
 * desktop (`files#machine`), snapshots over the file root in a browser host
 * (`files/snapshot-history`).
 */
export const PrototypeHistoryStore =
  defineHostService<HistoryStore>("prototypes.history");

/** A (possibly abbreviated) version sha — hex only, so it can never be an option or a rev expression. */
export function isVersionSha(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(sha);
}

/** One entry of a flat prototype folder: no separator, no `.`/`..`, no NUL. */
export function isFlatFileName(file: string): boolean {
  return (
    file !== "" &&
    file !== "." &&
    file !== ".." &&
    !/[/\\]/.test(file) &&
    !file.includes("\0")
  );
}

/** {@link isVersionSha}, or a throw — for a store past the route's 404. */
export function assertVersionSha(sha: string): string {
  if (!isVersionSha(sha)) {
    throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/** {@link isFlatFileName}, or a throw — for a store past the route's 404. */
export function assertFlatFileName(file: string): string {
  if (!isFlatFileName(file)) {
    throw new Error(
      `not a file name in a prototype folder: ${JSON.stringify(file)}`,
    );
  }
  return file;
}
