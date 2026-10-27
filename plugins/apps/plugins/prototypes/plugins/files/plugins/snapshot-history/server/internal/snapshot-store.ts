import { z } from "zod";
import {
  joinRel,
  readText,
  relPath,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { createSha256 } from "@plugins/packages/plugins/string-hash/core";
import {
  PROTOTYPE_ENTRY_FILE,
  PROTOTYPE_VERSION_KINDS,
  protoIdKind,
  readPrototypeOptions,
  type PrototypeOption,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  HISTORY_DIR_NAME,
  LATEST_STAMP_FILE,
  LatestStampSchema,
  assertFlatFileName,
  assertPrototypeId,
  assertVersionSha,
  checkpointMessage,
  historyDirOf,
  historyStampOf,
  type CheckpointResult,
  type EnsureHistoryResult,
  type HistoryRead,
  type HistoryStore,
  type RestoreResult,
  type VersionEntry,
  type VersionFileRead,
} from "@plugins/apps/plugins/prototypes/plugins/files/server";

// The prototype version store for a host without the computer — no git, so a
// version is a SNAPSHOT: the folder's files by content hash, kept beside the
// folder in the same tree, `_history/<id>.snapshots/`:
//
//   log.json      every version, oldest → newest: its message fields, when,
//                 and `files` — name → the sha256 of its bytes
//   blobs/<hash>  each distinct file content, stored once
//   latest.json   `{ n, sha }` of the newest version — the stamp the tree's
//                 watch turns into a notify, exactly as for a git repo
//
// A version's sha is the sha256 of what it records (its parent, time, message
// and files), so it addresses the content like a commit does and passes the
// routes' `isVersionSha`. Dot-files are never part of a version (git's
// `info/exclude` is `.*`). One writer per prototype at a time: the
// `_history/<id>` lock, the same key the git store takes.

/** The history dir's suffix: `_history/<id>.snapshots`. */
export const SNAPSHOT_HISTORY_FORMAT = "snapshots";

const LOG_FILE = "log.json";
const BLOBS_DIR = "blobs";

const SnapshotVersionSchema = z.object({
  sha: z.string(),
  at: z.string(),
  kind: z.enum(PROTOTYPE_VERSION_KINDS),
  subject: z.string(),
  body: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  /** File name → the sha256 of its bytes (`blobs/<hash>`). */
  files: z.record(z.string(), z.string()),
});
type SnapshotVersion = z.infer<typeof SnapshotVersionSchema>;

const SnapshotLogSchema = z.object({
  versions: z.array(SnapshotVersionSchema),
});

/** One file of the live folder, hashed. */
interface LiveFile {
  hash: string;
  bytes: Uint8Array;
}

/** What one version records, before it has a sha. */
interface VersionDraft {
  kind: SnapshotVersion["kind"];
  subject: string;
  body: string;
  conversationId: string | null;
  messageId: string | null;
}

// Every write the store makes is its own bookkeeping, or a restore the user
// asked for — never an agent's edit the ledger would revert.
const writer = systemOrigin("prototype snapshot history");

/**
 * Each version's declared options, by sha. A version never changes, so its
 * options are read once per process — the history is re-read on every edit of
 * its folder (the dirty flag).
 */
const versionOptionsMemo = new Map<string, PrototypeOption[]>();

/** The snapshot store over the prototypes tree `files`. */
export function openSnapshotHistoryStore(files: Mount): HistoryStore {
  const dirOf = (id: string): RelPath =>
    historyDirOf(id, SNAPSHOT_HISTORY_FORMAT);
  const logOf = (id: string): RelPath => joinRel(dirOf(id), LOG_FILE);
  const blobOf = (id: string, hash: string): RelPath =>
    joinRel(dirOf(id), BLOBS_DIR, hash);
  const withHistoryLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    files.withLock(relPath(HISTORY_DIR_NAME, assertPrototypeId(id)), fn);

  /** The live folder's files (dot-files skipped); `null` when there is no folder. */
  async function readFolder(id: string): Promise<Map<string, LiveFile> | null> {
    const folder = relPath(assertPrototypeId(id));
    const listed = await files.list(folder);
    if (listed.kind === "missing") return null;
    const out = new Map<string, LiveFile>();
    for (const entry of listed.entries) {
      if (entry.kind !== "file" || entry.name.startsWith(".")) continue;
      const read = await files.read(joinRel(folder, entry.name));
      // Removed between the listing and the read: no longer in the folder.
      if (read.kind === "missing") continue;
      const bytes = new Uint8Array(await read.blob.arrayBuffer());
      out.set(entry.name, { hash: createSha256().update(bytes).hex(), bytes });
    }
    return out;
  }

  async function folderExists(id: string): Promise<boolean> {
    const stat = await files.stat(relPath(assertPrototypeId(id)));
    return stat.kind === "found" && stat.entry.kind === "dir";
  }

  /** The log; `null` when the prototype has no history yet. */
  async function readLog(id: string): Promise<SnapshotVersion[] | null> {
    const read = await readText(files, logOf(id));
    if (read.kind === "missing") return null;
    const parsed = SnapshotLogSchema.safeParse(JSON.parse(read.text));
    if (!parsed.success) {
      throw new Error(
        `malformed snapshot history ${logOf(id)}: ${parsed.error.message}`,
      );
    }
    return parsed.data.versions;
  }

  /**
   * Append one version: its new blobs, then the log (atomically — the log is
   * what makes it exist), then the stamp. Runs under the history lock.
   */
  async function record(
    id: string,
    log: SnapshotVersion[],
    live: Map<string, LiveFile>,
    draft: VersionDraft,
  ): Promise<PrototypeVersion> {
    const known = new Set(log.flatMap((v) => Object.values(v.files)));
    for (const file of live.values()) {
      if (known.has(file.hash)) continue;
      await files.write(blobOf(id, file.hash), file.bytes, { writer });
      known.add(file.hash);
    }
    const fileHashes = Object.fromEntries(
      [...live.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, file]) => [name, file.hash]),
    );
    const at = new Date().toISOString();
    const parent = log.at(-1)?.sha ?? null;
    const sha = createSha256()
      .update(JSON.stringify({ parent, at, ...draft, files: fileHashes }))
      .hex();
    const version: SnapshotVersion = { sha, at, ...draft, files: fileHashes };
    const next = [...log, version];
    await files.write(logOf(id), JSON.stringify({ versions: next }), {
      writer,
    });
    const n = next.length - 1;
    await files.write(
      historyStampOf(id, SNAPSHOT_HISTORY_FORMAT),
      JSON.stringify({ n, sha }),
      { writer },
    );
    return toVersion(id, version, n);
  }

  /** A version as the wire carries it, with the options its own page declares. */
  async function toVersion(
    id: string,
    v: SnapshotVersion,
    n: number,
  ): Promise<PrototypeVersion> {
    return {
      n,
      sha: v.sha,
      at: v.at,
      kind: v.kind,
      subject: v.subject,
      conversationId: v.conversationId,
      messageId: v.messageId,
      options: await versionOptions(id, v),
    };
  }

  async function versionOptions(
    id: string,
    v: SnapshotVersion,
  ): Promise<PrototypeOption[]> {
    const memo = versionOptionsMemo.get(v.sha);
    if (memo !== undefined) return memo;
    const hash = v.files[PROTOTYPE_ENTRY_FILE];
    // No `index.html` in a version is a version that declares nothing — an
    // empty folder's baseline — not a failed read.
    const options =
      hash === undefined
        ? []
        : readPrototypeOptions(await readBlobText(id, hash)).options;
    versionOptionsMemo.set(v.sha, options);
    return options;
  }

  async function readBlob(
    id: string,
    hash: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const read = await files.read(blobOf(id, hash));
    if (read.kind === "missing") {
      throw new Error(
        `snapshot history of ${id} names a blob it does not hold: ${blobOf(id, hash)}`,
      );
    }
    return new Uint8Array(await read.blob.arrayBuffer());
  }

  async function readBlobText(id: string, hash: string): Promise<string> {
    return new TextDecoder().decode(await readBlob(id, hash));
  }

  async function ensureHistory(id: string): Promise<EnsureHistoryResult> {
    if (!(await folderExists(id))) return { kind: "no-such-prototype" };
    if ((await readLog(id)) !== null) return { kind: "exists" };
    return withHistoryLock(id, async () => {
      if ((await readLog(id)) !== null) return { kind: "exists" };
      const live = await readFolder(id);
      if (live === null) return { kind: "no-such-prototype" };
      await record(id, [], live, {
        kind: "baseline",
        subject: "Baseline",
        body: "",
        conversationId: null,
        messageId: null,
      });
      return { kind: "created" };
    });
  }

  /** The newest version, and whether the live folder differs from it. */
  function isDirty(log: SnapshotVersion[], live: Map<string, LiveFile>) {
    return !sameFiles(log.at(-1)?.files ?? {}, live);
  }

  return {
    ensureHistory,

    async adoptAll() {
      const listed = await files.list(relPath());
      if (listed.kind === "missing") return;
      const ids = listed.entries
        .filter((e) => e.kind === "dir" && protoIdKind.is(e.name))
        .map((e) => e.name);
      // One failure must not stop the rest from being adopted; all of them are
      // reported together afterwards.
      const failures: unknown[] = [];
      for (const id of ids) {
        try {
          await ensureHistory(id);
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `could not adopt ${failures.length} prototype snapshot histor${failures.length === 1 ? "y" : "ies"}`,
        );
      }
    },

    async checkpoint(id, input): Promise<CheckpointResult> {
      if ((await ensureHistory(id)).kind === "no-such-prototype") {
        return { kind: "no-such-prototype" };
      }
      return withHistoryLock(id, async () => {
        const log = await requireLog(id);
        if (
          input.messageId !== undefined &&
          log.some((v) => v.messageId === input.messageId)
        ) {
          return { kind: "unchanged" };
        }
        const live = await readFolder(id);
        if (live === null) return { kind: "no-such-prototype" };
        if (!isDirty(log, live)) return { kind: "unchanged" };
        return {
          kind: "recorded",
          version: await record(id, log, live, checkpointMessage(input)),
        };
      });
    },

    async readHistory(id): Promise<HistoryRead> {
      if ((await ensureHistory(id)).kind === "no-such-prototype") {
        return { kind: "no-such-prototype" };
      }
      const log = await requireLog(id);
      const live = await readFolder(id);
      if (live === null) return { kind: "no-such-prototype" };
      const versions = await Promise.all(
        log.map((v, n) => toVersion(id, v, n)),
      );
      const entries: VersionEntry[] = versions.map((version, n) => ({
        ...version,
        body: log[n]!.body,
      }));
      return {
        kind: "history",
        history: { versions, dirty: isDirty(log, live) },
        entries,
      };
    },

    async readVersionCounts() {
      const listed = await files.list(relPath(HISTORY_DIR_NAME));
      // No history dir yet: no prototype has a history — a real, empty answer.
      if (listed.kind === "missing") return {};
      const suffix = `.${SNAPSHOT_HISTORY_FORMAT}`;
      const ids = listed.entries
        .filter((e) => e.kind === "dir" && e.name.endsWith(suffix))
        .map((e) => e.name.slice(0, -suffix.length))
        .filter(protoIdKind.is);
      const counts: Record<string, number> = {};
      for (const id of ids) {
        const path = joinRel(dirOf(id), LATEST_STAMP_FILE);
        const read = await readText(files, path);
        // A history without a stamp: its count is unknown here.
        if (read.kind === "missing") continue;
        const stamp = LatestStampSchema.safeParse(JSON.parse(read.text));
        if (!stamp.success) {
          throw new Error(
            `malformed version stamp ${path}: ${stamp.error.message}`,
          );
        }
        counts[id] = stamp.data.n + 1;
      }
      return counts;
    },

    async readVersionFile(id, sha, file): Promise<VersionFileRead> {
      assertVersionSha(sha);
      assertFlatFileName(file);
      const log = await readLog(id);
      if (log === null) return { kind: "not-found" };
      const version = uniqueVersion(log, sha);
      const hash = version?.files[file];
      if (hash === undefined) return { kind: "not-found" };
      return { kind: "found", bytes: await readBlob(id, hash) };
    },

    async restoreVersion(id, sha): Promise<RestoreResult> {
      assertVersionSha(sha);
      if ((await ensureHistory(id)).kind === "no-such-prototype") {
        return { kind: "no-such-prototype" };
      }
      return withHistoryLock(id, async () => {
        let log = await requireLog(id);
        const index = log.findIndex((v) => v === uniqueVersion(log, sha));
        const target = log[index];
        if (target === undefined) return { kind: "unknown-version" };

        const live = await readFolder(id);
        if (live === null) return { kind: "no-such-prototype" };
        if (isDirty(log, live)) {
          await record(id, log, live, {
            kind: "manual",
            subject: "Before restore",
            body: `Unsaved changes, recorded before restoring v${index}.`,
            conversationId: null,
            messageId: null,
          });
          log = await requireLog(id);
        }

        // The old files written back, and every file it lacks deleted.
        // Dot-files are not part of a version, so they are left alone.
        const folder = relPath(id);
        for (const [name, hash] of Object.entries(target.files)) {
          if (live.get(name)?.hash === hash) continue;
          await files.write(joinRel(folder, name), await readBlob(id, hash), {
            writer,
          });
        }
        for (const name of live.keys()) {
          if (target.files[name] !== undefined) continue;
          await files.remove(joinRel(folder, name), {
            writer,
            recursive: false,
          });
        }

        const restored = await readFolder(id);
        if (restored === null) return { kind: "no-such-prototype" };
        // Recorded even when the content is what the folder already had: it is
        // still the restore the user asked for, and must show up as one.
        return {
          kind: "restored",
          version: await record(id, log, restored, {
            kind: "restore",
            subject: `Restored v${index}`,
            body: `Restored from ${target.sha}.`,
            conversationId: null,
            messageId: null,
          }),
        };
      });
    },
  };

  /** The log of a prototype `ensureHistory` just vouched for. */
  async function requireLog(id: string): Promise<SnapshotVersion[]> {
    const log = await readLog(id);
    if (log === null) {
      throw new Error(`snapshot history of ${id} vanished: ${logOf(id)}`);
    }
    return log;
  }
}

/** The one version `sha` (or an abbreviation of exactly one) names, else `undefined`. */
function uniqueVersion(
  log: readonly SnapshotVersion[],
  sha: string,
): SnapshotVersion | undefined {
  const matches = log.filter((v) => v.sha.startsWith(sha));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether the live folder holds exactly `recorded`'s files and bytes. */
function sameFiles(
  recorded: Record<string, string>,
  live: Map<string, LiveFile>,
): boolean {
  const names = Object.keys(recorded);
  return (
    names.length === live.size &&
    names.every((name) => live.get(name)?.hash === recorded[name])
  );
}
