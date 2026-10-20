import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// ── Shared shapes ────────────────────────────────────────────────────────────

/**
 * What one directory entry is, judged by what it RESOLVES to: a symlink to a
 * directory is a `dir` (and carries `symlinkTarget`), a symlink to a file is a
 * `file`. `symlink` is reserved for a link that resolves to nothing readable
 * (dangling, looping, or behind a denied directory). `other` is a socket, FIFO
 * or device.
 */
export const HostFsEntryKindSchema = z.enum([
  "dir",
  "file",
  "symlink",
  "other",
]);
export type HostFsEntryKind = z.infer<typeof HostFsEntryKindSchema>;

export const HostFsEntrySchema = z.object({
  name: z.string(),
  kind: HostFsEntryKindSchema,
  /** Bytes, of the resolved target for a followed symlink. */
  size: z.number(),
  mtimeMs: z.number(),
  /**
   * When the entry was created, where the filesystem records it. Absent inside
   * an archive, and on a filesystem without birth time.
   */
  birthtimeMs: z.number().optional(),
  /**
   * Last access as the filesystem records it — approximate (relatime / lazy
   * updates, and our own reads bump it). Absent inside an archive.
   */
  atimeMs: z.number().optional(),
  /** A dotfile. Presentation only: hidden entries are still listed. */
  hidden: z.boolean(),
  /** The link's own text (`readlink`), present iff the entry is a symlink. */
  symlinkTarget: z.string().optional(),
  /**
   * Present on a real file whose name a registered archive format claims
   * (`.zip`, …): it stays a `file`, and can also be browsed like a folder —
   * `list` of its path lists the archive's root. Never set on an entry inside
   * an archive (archives within archives are not browsed).
   */
  archive: z.object({ format: z.string() }).optional(),
});
export type HostFsEntry = z.infer<typeof HostFsEntrySchema>;

/**
 * Whether an entry can be opened like a folder: a directory, or an archive
 * file. The one test every "does this expand?" decision makes — a consumer
 * that wants real directories only (a folder picker) tests `kind === "dir"`.
 */
export function isBrowsable(
  entry: Pick<HostFsEntry, "kind" | "archive">,
): boolean {
  return entry.kind === "dir" || entry.archive !== undefined;
}

/**
 * Set on a `list` / `stat` answer whose path lies INSIDE an archive: the path
 * is virtual (`…/photos.zip/2022/a.jpg`), so it has no git status, cannot be
 * opened with its default app, and is revealed as the archive file itself.
 */
export const HostFsWithinSchema = z.object({
  /** The archive file on disk, absolute. */
  archive: z.string(),
  format: z.string(),
});
export type HostFsWithin = z.infer<typeof HostFsWithinSchema>;

/** Why an archive (or one member of it) cannot be read. */
export const HostFsArchiveReasonSchema = z.enum([
  "corrupt",
  "encrypted",
  "unsupported-method",
  "too-many-entries",
]);
export type HostFsArchiveReason = z.infer<typeof HostFsArchiveReasonSchema>;

/** The path does not exist (ENOENT, or a component of it is not a directory). */
const Missing = z.object({ kind: z.literal("missing"), path: z.string() });
/** The user account may not read it (EACCES / EPERM — e.g. ~/.Trash without Full Disk Access). */
const Denied = z.object({ kind: z.literal("denied"), path: z.string() });
const NotADir = z.object({ kind: z.literal("not-a-dir"), path: z.string() });
const NotAFile = z.object({ kind: z.literal("not-a-file"), path: z.string() });
/** The path crosses into an archive that cannot be read (or a member that cannot be decoded). */
const UnreadableArchive = z.object({
  kind: z.literal("unreadable-archive"),
  path: z.string(),
  /** The archive file on disk. */
  archive: z.string(),
  reason: HostFsArchiveReasonSchema,
});

// Every host-fs read takes an absolute path or one starting with `~`
// (expanded to the user's home). A relative path, or one carrying a NUL, is a
// 400 (a live read's `invalid-path` refusal) — there is no working directory a
// host path could be relative to.
//
// A path may cross into an archive (`~/Downloads/x.zip/photos/a.jpg`): `stat`
// and `raw` read the member; `complete` stays on disk. (The list / text /
// volume results below are what the live reads in `./live.ts` answer.)

// ── list ─────────────────────────────────────────────────────────────────────

export const HostFsListResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    /** The resolved absolute path (`~` expanded, `..` collapsed, no trailing slash). */
    path: z.string(),
    /** `null` at the filesystem root. */
    parent: z.string().nullable(),
    /** Every entry, hidden ones included, sorted by name. */
    entries: z.array(HostFsEntrySchema),
    within: HostFsWithinSchema.optional(),
  }),
  Missing,
  Denied,
  NotADir,
  UnreadableArchive,
]);
export type HostFsListResult = z.infer<typeof HostFsListResultSchema>;

// ── peek ─────────────────────────────────────────────────────────────────────

/**
 * How many child names `peek` returns for one folder at most. A fuller folder
 * answers `too-many` with its raw total instead of shipping every name.
 */
export const HOST_FS_PEEK_MAX_NAMES = 10_000;

export const HostFsPeekResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    /** Every child, hidden ones included, by name only — no child is stat'ed. */
    children: z.array(z.object({ name: z.string(), hidden: z.boolean() })),
  }),
  /** More than {@link HOST_FS_PEEK_MAX_NAMES} children: `total` counts them all. */
  z.object({
    kind: z.literal("too-many"),
    path: z.string(),
    total: z.number(),
  }),
  /**
   * An archive file on disk: `peek` never opens one (reading its index is not
   * the cheap read peek promises). `list` of its path lists its root.
   */
  z.object({ kind: z.literal("archive"), path: z.string() }),
  Missing,
  Denied,
  NotADir,
  UnreadableArchive,
]);
/**
 * What one folder holds, by name — the machine half's own answer, which the
 * `host-fs.peek` live value (`hostFsDirPeek`) serves with its failures as
 * refusals.
 */
export type HostFsPeekResult = z.infer<typeof HostFsPeekResultSchema>;

// ── stat ─────────────────────────────────────────────────────────────────────

export const HostFsStatResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    parent: z.string().nullable(),
    entry: HostFsEntrySchema,
    within: HostFsWithinSchema.optional(),
  }),
  Missing,
  Denied,
  UnreadableArchive,
]);
export type HostFsStatResult = z.infer<typeof HostFsStatResultSchema>;

/** Describe one host path (e.g. path-bar validation: a file → open its parent). */
export const hostFsStat = defineEndpoint({
  route: "GET /api/host-fs/stat",
  query: z.object({ path: z.string() }),
  response: HostFsStatResultSchema,
});

// ── complete ─────────────────────────────────────────────────────────────────

/** How many completions one request returns at most (`truncated` says if there were more). */
export const HOST_FS_COMPLETE_LIMIT = 50;

export const HostFsCompleteResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    /** The directory whose children were matched (`dirname` of the prefix). */
    dir: z.string(),
    matches: z.array(z.object({ name: z.string(), path: z.string() })),
    truncated: z.boolean(),
  }),
  Missing,
  Denied,
  NotADir,
]);
export type HostFsCompleteResult = z.infer<typeof HostFsCompleteResultSchema>;

/**
 * Folder-only completions of a typed path: the directories (symlinks to
 * directories included) in `dirname(prefix)` whose name starts with
 * `basename(prefix)`, case-insensitively. A prefix ending in `/` completes
 * every child of that directory. Dotfolders are offered only once the typed
 * fragment starts with `.`. Expands `~`.
 */
export const hostFsComplete = defineEndpoint({
  route: "GET /api/host-fs/complete",
  query: z.object({ prefix: z.string() }),
  response: HostFsCompleteResultSchema,
});

// ── text ─────────────────────────────────────────────────────────────────────

/** The largest file `text` decodes (2 MiB). Bigger files answer `too-large`. */
export const HOST_FS_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export const HostFsTextResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    content: z.string(),
    size: z.number(),
  }),
  z.object({
    kind: z.literal("too-large"),
    path: z.string(),
    size: z.number(),
  }),
  /** A NUL byte in the first 8 KB. */
  z.object({ kind: z.literal("binary"), path: z.string(), size: z.number() }),
  Missing,
  Denied,
  NotAFile,
  UnreadableArchive,
]);
export type HostFsTextResult = z.infer<typeof HostFsTextResultSchema>;

// ── raw ──────────────────────────────────────────────────────────────────────

/**
 * A host file's bytes, streamed: `Content-Type` from the extension, `Range`
 * honoured (one range; PDF / video seeking), served inline but sandboxed
 * (`Content-Security-Policy: sandbox`, `nosniff`, `Cross-Origin-Resource-Policy:
 * same-site`) so an HTML or SVG file cannot run script on the app's origin. A PDF
 * drops `sandbox` (the browser's PDF viewer will not run in a sandboxed document).
 * 404 missing, 403 denied, 400 for a directory, 422 for an unreadable archive
 * member. A member stored uncompressed honours `Range`; a compressed one is
 * served whole (RFC 9110 lets a server ignore Range). Build URLs with
 * `hostFileUrl`.
 */
export const hostFsRaw = defineEndpoint({
  route: "GET /api/host-fs/raw",
  query: z.object({ path: z.string() }),
  response: blob(),
});

/** The same-origin URL of a host file's raw bytes (for `<img src>`, `<video>`, iframes, links). */
export function hostFileUrl(path: string): string {
  return `${hostFsRaw.path}?${new URLSearchParams({ path }).toString()}`;
}

// ── volume ───────────────────────────────────────────────────────────────────

export const HostFsVolumeResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    /** The volume's display name ("Macintosh HD", or the `/Volumes/<name>` it is mounted at). */
    name: z.string(),
    /** Bytes. */
    total: z.number(),
    /** Bytes available to the user account. */
    free: z.number(),
  }),
  Missing,
  Denied,
]);
/**
 * The storage of the volume holding a path — the machine half's own answer,
 * which the `host-fs.volume` live value (`hostFsVolumeInfo`) serves with its
 * failures as refusals.
 */
export type HostFsVolumeResult = z.infer<typeof HostFsVolumeResultSchema>;

// ── open ─────────────────────────────────────────────────────────────────────

export const HostFsOpenResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), path: z.string() }),
  /** Open with default app on a file inside an archive: there is no file on disk to hand an app. */
  z.object({
    kind: z.literal("in-archive"),
    path: z.string(),
    archive: z.string(),
  }),
  Missing,
  Denied,
]);
export type HostFsOpenResult = z.infer<typeof HostFsOpenResultSchema>;

/**
 * Open a host path with its default app (`open <path>`), or reveal it in the
 * Finder (`reveal: true` → `open -R <path>`; a path inside an archive reveals
 * the archive). The one side effect host-fs has:
 * a request whose `Origin` is not a `*.localhost` origin is refused (403).
 */
export const hostFsOpen = defineEndpoint({
  route: "POST /api/host-fs/open",
  body: z.object({ path: z.string(), reveal: z.boolean().optional() }),
  response: HostFsOpenResultSchema,
});

// ── extract ──────────────────────────────────────────────────────────────────

export const HostFsExtractResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("extracted"),
    /** The archive file, absolute. */
    path: z.string(),
    /** What the extraction created beside the archive, absolute. */
    created: z.string(),
    /**
     * `single`: the archive held one top-level entry (a folder or a file),
     * extracted as itself. `folder`: it held several, so they were extracted
     * into a new folder named after the archive.
     */
    layout: z.enum(["single", "folder"]),
  }),
  /** The path is not a file on disk any registered archive format claims. */
  z.object({ kind: z.literal("not-an-archive"), path: z.string() }),
  Missing,
  Denied,
  UnreadableArchive,
]);
export type HostFsExtractResult = z.infer<typeof HostFsExtractResultSchema>;

/**
 * Extract an archive file next to itself, the way the Finder does: an archive
 * holding exactly one top-level entry (a folder, or a single file) puts that
 * entry beside it; one holding several puts them in a new folder named after
 * the archive (`photos.zip` → `photos/`). Nothing is overwritten — a name
 * already taken gets a number (`photos 2`). The work is staged in a hidden
 * sibling and moved into place at the end, so a failed extraction leaves
 * nothing behind. macOS's `__MACOSX/` resource forks and `.DS_Store` files are
 * not extracted. A request whose `Origin` is not a `*.localhost` origin is
 * refused (403), as `open` is.
 */
export const hostFsExtract = defineEndpoint({
  route: "POST /api/host-fs/extract",
  body: z.object({ path: z.string() }),
  response: HostFsExtractResultSchema,
});

// ── move ─────────────────────────────────────────────────────────────────────

/** How many sources one `move` request moves at most. */
export const HOST_FS_MOVE_MAX_SOURCES = 1000;

/**
 * What to do with a source whose name is already taken in the destination:
 * `replace` the taken entry, `keep-both` (the source gets the Finder's next
 * free name, `a 2.txt`), or `skip` it.
 */
export const HostFsMoveResolutionSchema = z.enum([
  "replace",
  "keep-both",
  "skip",
]);
export type HostFsMoveResolution = z.infer<typeof HostFsMoveResolutionSchema>;

/** What happened to one source of a `move`. `from` is the resolved source path. */
export const HostFsMoveOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("moved"), from: z.string(), to: z.string() }),
  /**
   * `to` is taken and the request carried no resolution for this source:
   * nothing was moved. Re-send it with one.
   */
  z.object({ kind: z.literal("exists"), from: z.string(), to: z.string() }),
  /** Taken, and the request's resolution said `skip`. */
  z.object({ kind: z.literal("skipped"), from: z.string() }),
  /** A folder dropped into itself or one of its descendants. */
  z.object({ kind: z.literal("into-self"), from: z.string() }),
  /**
   * `replace` would delete a folder that holds the source itself (moving
   * `Docs/a/a` up into `Docs`, replacing `Docs/a`): refused, nothing moved.
   */
  z.object({
    kind: z.literal("replaces-ancestor"),
    from: z.string(),
    to: z.string(),
  }),
  /** The source already sits in the destination: nothing to do. */
  z.object({ kind: z.literal("same-dir"), from: z.string() }),
  z.object({ kind: z.literal("missing"), from: z.string() }),
  z.object({ kind: z.literal("denied"), from: z.string() }),
  /** The source is a member inside an archive: a virtual path, not movable. */
  z.object({ kind: z.literal("archive"), from: z.string() }),
]);
export type HostFsMoveOutcome = z.infer<typeof HostFsMoveOutcomeSchema>;

export const HostFsMoveResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    /** The resolved destination folder. */
    destDir: z.string(),
    /** One outcome per source, aligned with the request's `sources`. */
    results: z.array(HostFsMoveOutcomeSchema),
  }),
  // The destination itself cannot take anything: no source was touched.
  Missing,
  Denied,
  NotADir,
  /** The destination lies inside an archive (or is an archive file's root). */
  z.object({ kind: z.literal("archive"), path: z.string() }),
]);
export type HostFsMoveResult = z.infer<typeof HostFsMoveResultSchema>;

/**
 * Move host paths into a folder, the way the Finder does: each source keeps
 * its name; a folder cannot go into itself or a descendant; a source already
 * in `destDir` is left alone. A name already taken in `destDir` is NOT
 * overwritten unless asked: without a `resolutions` entry for that source it
 * answers `exists` (the other sources still move), and the caller re-sends it
 * with `replace` / `keep-both` / `skip`. `resolutions` is keyed by source path
 * (as sent, or as answered in `from`). Across volumes the source is copied
 * then removed. Archive members are refused on either side. A request whose
 * `Origin` is not a `*.localhost` origin is refused (403), as `open` is.
 */
export const hostFsMove = defineEndpoint({
  route: "POST /api/host-fs/move",
  body: z.object({
    sources: z.array(z.string()).min(1).max(HOST_FS_MOVE_MAX_SOURCES),
    destDir: z.string(),
    resolutions: z.record(z.string(), HostFsMoveResolutionSchema).optional(),
  }),
  response: HostFsMoveResultSchema,
});
