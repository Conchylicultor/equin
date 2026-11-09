import type {
  FileArchiveReason,
  FileEntry,
  FileReadAccess,
  FileWithin,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";

// What host-fs's readers answer about the computer's disk — this plugin's own
// shapes, private to it (server/ and machine/). An entry, an archive's
// `within` and a read access are file-systems' (`FileEntry`, …): the disk is
// one file system, so it has no entry type of its own. Every read a surface
// makes is file-systems' `files.computer.*` declaration, served by machine/
// with these answers' failure kinds turned into refusals (`refusalFor`).
//
// Every reader takes an absolute path or one starting with `~` (expanded to
// the user's home). A path may cross into an archive
// (`~/Downloads/x.zip/photos/a.jpg`): `stat` and the byte reads read the
// member; `complete` stays on disk.

/** The path does not exist (ENOENT, or a component of it is not a directory). */
type Missing = { kind: "missing"; path: string };
/** The user account may not read it (EACCES / EPERM — e.g. ~/.Trash without Full Disk Access). */
type Denied = { kind: "denied"; path: string };
type NotADir = { kind: "not-a-dir"; path: string };
type NotAFile = { kind: "not-a-file"; path: string };
/** The path crosses into an archive that cannot be read (or a member that cannot be decoded). */
type UnreadableArchive = {
  kind: "unreadable-archive";
  path: string;
  /** The archive file on disk. */
  archive: string;
  reason: FileArchiveReason;
};

/** A folder listed. */
export type HostFsListResult =
  | {
      kind: "ok";
      /** The resolved absolute path (`~` expanded, `..` collapsed, no trailing slash). */
      path: string;
      /** `null` at the filesystem root. */
      parent: string | null;
      /** Every entry, hidden ones included, sorted by name. */
      entries: FileEntry[];
      within?: FileWithin;
    }
  | Missing
  | Denied
  | NotADir
  | UnreadableArchive;

/** A folder's child names (at most `FILE_PEEK_MAX_NAMES`). */
export type HostFsPeekResult =
  | {
      kind: "ok";
      path: string;
      /** Every child, hidden ones included, by name only — no child is stat'ed. */
      children: { name: string; hidden: boolean }[];
    }
  /** More than `FILE_PEEK_MAX_NAMES` children: `total` counts them all. */
  | { kind: "too-many"; path: string; total: number }
  /** An archive file on disk: a peek never opens one. */
  | { kind: "archive"; path: string }
  | Missing
  | Denied
  | NotADir
  | UnreadableArchive;

/** One path described. */
export type HostFsStatResult =
  | {
      kind: "ok";
      path: string;
      parent: string | null;
      entry: FileEntry;
      within?: FileWithin;
      /** Absent on an unresolvable symlink (`entry.kind` `symlink`): no contents to read. */
      read?: FileReadAccess;
    }
  | Missing
  | Denied
  | UnreadableArchive;

/** A typed path's folder completions (at most `FILE_COMPLETE_LIMIT`). */
export type HostFsCompleteResult =
  | {
      kind: "ok";
      /** The directory whose children were matched (`dirname` of the prefix). */
      dir: string;
      matches: { name: string; path: string }[];
      truncated: boolean;
    }
  | Missing
  | Denied
  | NotADir;

/** A file decoded as text (at most `FILE_TEXT_MAX_BYTES`). */
export type HostFsTextResult =
  | { kind: "ok"; path: string; content: string; size: number }
  | { kind: "too-large"; path: string; size: number }
  /** A NUL byte in the first 8 KB. */
  | { kind: "binary"; path: string; size: number }
  | Missing
  | Denied
  | NotAFile
  | UnreadableArchive;

/** The storage of the volume holding a path. */
export type HostFsVolumeResult =
  | {
      kind: "ok";
      path: string;
      /** The volume's display name ("Macintosh HD", or the `/Volumes/<name>` it is mounted at). */
      name: string;
      /** Bytes. */
      total: number;
      /** Bytes available to the user account. */
      free: number;
    }
  | Missing
  | Denied;

/**
 * A file's on-disk revision: an opaque stamp that moves whenever its bytes
 * may have (inode, size, mtime of the entry holding them — the archive file,
 * for a member of one), `null` while nothing readable is there. It carries no
 * content: a reader holds it beside its own read of the file and re-reads when
 * it moves.
 */
export type FileVersion = { stamp: string | null };
