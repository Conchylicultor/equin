import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  defineEndpoint,
  type MachineFeature,
} from "@plugins/infra/plugins/endpoints/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import {
  FileEntrySchema,
  FileWithinSchema,
  browserFileStat,
  computerFileStat,
  type FileEntry,
} from "./reads";

// The folders of a file system — what a file browser (Files) reads and
// changes, declared once per system that HAS folders to browse
// (`BrowsableFileSystem`; a checkout is read file by file). Each system's half
// serves its own declarations, as for the file reads in `./reads.ts`: the
// computer's disk from host-fs's machine half, the browser's storage from the
// in-browser store. A browser never names one: it reads `useFolderListing(fs, …)`
// (web), `dirPeekOf(fs)`, `fileStatOf(fs)` for the system it shows, and offers an
// operation only where `FILE_SYSTEMS[fs].capabilities` says the system has it
// — an operation a system lacks has no declaration to call at all.

/** The file systems with folders a person browses. */
export type BrowsableFileSystem = "computer" | "browser";

/** Every browsable file system, in the order a list of them shows. */
export const BROWSABLE_FILE_SYSTEMS: readonly BrowsableFileSystem[] = [
  "computer",
  "browser",
];

/** Whether `fs` names a browsable file system (a route param, a stored pin). */
export function isBrowsableFileSystem(fs: string): fs is BrowsableFileSystem {
  return (BROWSABLE_FILE_SYSTEMS as readonly string[]).includes(fs);
}

/**
 * What a file system can do beyond listing its folders and reading its files
 * — the browser shows a control only for what its system has.
 */
export interface FileSystemCapabilities {
  /** Move entries into a folder (a drag onto a folder). */
  move: boolean;
  /** Browse into an archive file like a folder, and extract it beside itself. */
  archives: boolean;
  /**
   * Hand a file to the computer's own apps (Open with default app, Reveal in
   * Finder), and drag it out of the page as a real file.
   */
  openNative: boolean;
  /** Folder completions of a typed path (the path bar's suggestions). */
  completions: boolean;
  /** How full the system's storage is (the storage meter). */
  volume: boolean;
  /**
   * Resized copies of its images and their pixel sizes (thumbnails, a
   * screen-sized stage) — `./images.ts`.
   */
  images: boolean;
}

export interface FileSystemInfo {
  /** The system in words, where a list names several. */
  label: string;
  capabilities: FileSystemCapabilities;
}

/** Each browsable file system, as data both runtimes read. */
export const FILE_SYSTEMS: Readonly<
  Record<BrowsableFileSystem, FileSystemInfo>
> = {
  computer: {
    label: "This computer",
    capabilities: {
      move: true,
      archives: true,
      openNative: true,
      completions: true,
      volume: true,
      images: true,
    },
  },
  browser: {
    label: "This browser",
    capabilities: {
      move: true,
      archives: false,
      openNative: false,
      completions: false,
      volume: false,
      images: false,
    },
  },
};

/**
 * Whether an entry opens like a folder: a directory, or an archive file. The
 * one test every "does this expand?" decision makes — a consumer that wants
 * real directories only (a folder picker) tests `kind === "dir"`.
 */
export function isBrowsable(
  entry: Pick<FileEntry, "kind" | "archive">,
): boolean {
  return entry.kind === "dir" || entry.archive !== undefined;
}

/**
 * The order a folder's entries are shown in, as people sort: by name, numbers
 * compared as numbers (`2` before `10`), case and accents only breaking ties.
 * A listing's pages arrive in code-point order, which only cuts pages: a
 * reader that shows them re-sorts with this.
 */
export function compareFileNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** What the computer's disk needs — the same words as its file reads. */
const COMPUTER = { feature: "Browsing this computer's files" } as const;

// ── list ─────────────────────────────────────────────────────────────────────

/** A listing's question: the folder (absolute, or `~`-rooted). */
export const FileListingQuerySchema = z.object({ path: z.string() });

/** What a listing says about its folder beside the entries — one per question. */
export const FileListingMetaSchema = z.object({
  /** The folder as the system resolves it (`~` expanded, `..` collapsed). */
  path: z.string(),
  /** `null` at the system's root. */
  parent: z.string().nullable(),
  /** How many entries the folder holds, hidden ones included. */
  total: z.number(),
  /** Set when the folder lies inside an archive. */
  within: FileWithinSchema.optional(),
});
export type FileListingMeta = z.infer<typeof FileListingMetaSchema>;

/**
 * How many entries a reader with no viewport holds of one folder at most —
 * the size past which a peek stops naming children too.
 */
export const FILE_PEEK_MAX_NAMES = 10_000;

/**
 * A folder's entries — key-range-PAGED, since a folder grows with the user's
 * data: each page a name range of entries in CODE-POINT order (`"B" < "a"`;
 * a surface that shows "as people sort" re-sorts with `compareFileNames`).
 * Read with `useFolderListing(fs, path)` (web) — pages and meta; the folder's
 * own facts are the meta sibling (`.meta`). Pushed while read from a watch of
 * the folder. An archive file lists its root; a symlink to a folder lists its
 * target. Refused: `invalid-path`, `missing`, `denied`, `not-a-dir`,
 * `unreadable-archive` (the message says why).
 */
export const computerFileListing = liveValue("files.computer.list", {
  query: FileListingQuerySchema,
  paged: {
    item: FileEntrySchema,
    id: "name",
    key: { of: (entry) => [entry.name], order: ["asc"] },
    limit: 500,
    maxLimit: FILE_PEEK_MAX_NAMES,
    meta: FileListingMetaSchema,
  },
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
  needsMachine: COMPUTER,
});

/** A folder of the browser's storage, as {@link computerFileListing}. */
export const browserFileListing = liveValue("files.browser.list", {
  query: FileListingQuerySchema,
  paged: {
    item: FileEntrySchema,
    id: "name",
    key: { of: (entry) => [entry.name], order: ["asc"] },
    limit: 500,
    maxLimit: FILE_PEEK_MAX_NAMES,
    meta: FileListingMetaSchema,
  },
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
});

/**
 * A declaration of any browsable system: the computer's, with whether it
 * needs the computer left to the system — so a read of it may be
 * `unavailable` (the arm a `needsMachine` adds), and the browser's portable
 * twin, which declares none, is one too.
 */
type AnySystem<D> = Omit<D, "needsMachine"> & {
  readonly needsMachine?: MachineFeature;
};

// ── peek ─────────────────────────────────────────────────────────────────────

/**
 * What a folder holds, by name only. Bounded: at most
 * {@link FILE_PEEK_MAX_NAMES} names — a fuller folder answers `too-many` with
 * its raw total — so a peek is never a whole-folder payload.
 */
export const FileDirPeekSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    path: z.string(),
    /** Every child, hidden ones included, by name only — no child is stat'ed. */
    children: z
      .array(z.object({ name: z.string(), hidden: z.boolean() }))
      .max(FILE_PEEK_MAX_NAMES),
  }),
  /** More than {@link FILE_PEEK_MAX_NAMES} children: `total` counts them all. */
  z.object({
    kind: z.literal("too-many"),
    path: z.string(),
    total: z.number(),
  }),
  /**
   * An archive file: a peek never opens one (reading its index is not the
   * cheap read a peek promises). Its listing lists its root.
   */
  z.object({ kind: z.literal("archive"), path: z.string() }),
]);
export type FileDirPeek = z.infer<typeof FileDirPeekSchema>;

/**
 * The child names of one folder — for counting a folder's items without
 * listing it. Many folders at once: `useLive(dirPeekOf(fs), paths.map((path)
 * => ({ path })))`. Pushed while read from a watch of the folder; refused as
 * a listing is.
 */
export const computerDirPeek = liveValue("files.computer.peek", {
  schema: FileDirPeekSchema,
  params: ["path"],
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
  needsMachine: COMPUTER,
});

/** The child names of a folder of the browser's storage, as {@link computerDirPeek}. */
export const browserDirPeek = liveValue("files.browser.peek", {
  schema: FileDirPeekSchema,
  params: ["path"],
  refusals: [
    "invalid-path",
    "missing",
    "denied",
    "not-a-dir",
    "unreadable-archive",
  ],
});

/** A peek of any browsable system (see {@link AnySystem}). */
export type DirPeekValue = AnySystem<typeof computerDirPeek>;

/** The peek of `fs`. */
export function dirPeekOf(fs: BrowsableFileSystem): DirPeekValue {
  switch (fs) {
    case "computer":
      return computerDirPeek;
    case "browser":
      return browserDirPeek;
  }
}

/** A stat of any browsable system (see {@link AnySystem}). */
export type FileStatValue = AnySystem<typeof computerFileStat>;

/** The stat of `fs` — what a path bar checks a typed path against. */
export function fileStatOf(fs: BrowsableFileSystem): FileStatValue {
  switch (fs) {
    case "computer":
      return computerFileStat;
    case "browser":
      return browserFileStat;
  }
}

// ── complete (the computer's disk) ───────────────────────────────────────────

/** How many completions one answer holds at most (`truncated` says if there were more). */
export const FILE_COMPLETE_LIMIT = 50;

export const FileCompletionsSchema = z.object({
  /** The folder whose children were matched (`dirname` of the prefix), absolute. */
  dir: z.string(),
  /** The matching folders, in natural name order. */
  matches: cappedList(z.object({ name: z.string(), path: z.string() }), {
    max: FILE_COMPLETE_LIMIT,
  }),
  /** More folders matched than {@link FILE_COMPLETE_LIMIT}. */
  truncated: z.boolean(),
});
export type FileCompletions = z.infer<typeof FileCompletionsSchema>;

/**
 * Folder-only completions of a typed path on the computer's disk: the folders
 * (symlinks to folders included) in `dirname(prefix)` whose name starts with
 * `basename(prefix)`, case-insensitively. A prefix ending in `/` completes
 * every child of that folder; dotfolders are offered only once the typed
 * fragment starts with `.`; `~` expands. Stays on disk (never inside an
 * archive). Pushed while read from a watch of the folder searched. Refused:
 * `invalid-path` (empty, relative or NUL), `missing`, `denied`, `not-a-dir`.
 */
export const computerFileCompletions = liveValue("files.computer.complete", {
  schema: FileCompletionsSchema,
  params: ["prefix"],
  refusals: ["invalid-path", "missing", "denied", "not-a-dir"],
  needsMachine: COMPUTER,
});

// ── volume (the computer's disk) ─────────────────────────────────────────────

export const FileVolumeSchema = z.object({
  path: z.string(),
  /** The volume's display name ("Macintosh HD", or the `/Volumes/<name>` it is mounted at). */
  name: z.string(),
  /** Bytes. */
  total: z.number(),
  /** Bytes available to the user account. */
  free: z.number(),
});
export type FileVolume = z.infer<typeof FileVolumeSchema>;

/**
 * The storage of the volume holding `path` (home when absent) — a SNAPSHOT:
 * free space moves with every write anywhere on the volume and nothing
 * signals it, so it is measured when a reader mounts and on `refresh()`.
 * Refused: `invalid-path`, `missing`, `denied`.
 */
export const computerVolume = liveValue("files.computer.volume", {
  schema: FileVolumeSchema,
  params: ["path?"],
  load: "snapshot",
  refusals: ["invalid-path", "missing", "denied"],
  needsMachine: COMPUTER,
});

// ── archives (the computer's disk) ───────────────────────────────────────────

/** Why an archive (or one member of it) cannot be read. */
export const FileArchiveReasonSchema = z.enum([
  "corrupt",
  "encrypted",
  "unsupported-method",
  "too-many-entries",
]);
export type FileArchiveReason = z.infer<typeof FileArchiveReasonSchema>;

/** The sentence an unreadable archive's answer carries, by reason. */
export function archiveReasonMessage(reason: FileArchiveReason): string {
  switch (reason) {
    case "corrupt":
      return "This archive is damaged or not in a format it claims";
    case "encrypted":
      return "This archive is encrypted";
    case "unsupported-method":
      return "This archive uses a compression method that cannot be read";
    case "too-many-entries":
      return "This archive has too many entries to browse";
  }
}

const Missing = z.object({ kind: z.literal("missing"), path: z.string() });
const Denied = z.object({ kind: z.literal("denied"), path: z.string() });
const NotADir = z.object({ kind: z.literal("not-a-dir"), path: z.string() });

export const FileExtractResultSchema = z.discriminatedUnion("kind", [
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
  z.object({
    kind: z.literal("unreadable-archive"),
    path: z.string(),
    archive: z.string(),
    reason: FileArchiveReasonSchema,
  }),
]);
export type FileExtractResult = z.infer<typeof FileExtractResultSchema>;

/**
 * Extract an archive file on the computer's disk next to itself, the way the
 * Finder does: one top-level entry is put beside it; several go into a new
 * folder named after the archive (`photos.zip` → `photos/`). Nothing is
 * overwritten — a taken name gets a number (`photos 2`). Staged in a hidden
 * sibling and moved into place at the end, so a failed extraction leaves
 * nothing behind.
 */
export const computerFileExtract = defineEndpoint({
  route: "POST /api/files/computer/extract",
  body: z.object({ path: z.string() }),
  response: FileExtractResultSchema,
  needsMachine: COMPUTER,
});

// ── open (the computer's disk) ───────────────────────────────────────────────

export const FileOpenResultSchema = z.discriminatedUnion("kind", [
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
export type FileOpenResult = z.infer<typeof FileOpenResultSchema>;

/**
 * Open a file on the computer's disk with its default app (`open <path>`), or
 * reveal it in the Finder (`reveal: true`; a path inside an archive reveals
 * the archive). macOS only (501 elsewhere).
 */
export const computerFileOpen = defineEndpoint({
  route: "POST /api/files/computer/open",
  body: z.object({ path: z.string(), reveal: z.boolean().optional() }),
  response: FileOpenResultSchema,
  needsMachine: COMPUTER,
});

// ── move ─────────────────────────────────────────────────────────────────────

/** How many sources one move moves at most. */
export const FILE_MOVE_MAX_SOURCES = 1000;

/**
 * What to do with a source whose name is already taken in the destination:
 * `replace` the taken entry, `keep-both` (the source gets the Finder's next
 * free name, `a 2.txt`), or `skip` it.
 */
export const FileMoveResolutionSchema = z.enum([
  "replace",
  "keep-both",
  "skip",
]);
export type FileMoveResolution = z.infer<typeof FileMoveResolutionSchema>;

/** What happened to one source of a move. `from` is the resolved source path. */
export const FileMoveOutcomeSchema = z.discriminatedUnion("kind", [
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
  /**
   * The source cannot be moved where it is: a member inside an archive (a
   * virtual path), or a folder the system keeps itself (an app's folder in
   * the browser's storage).
   */
  z.object({ kind: z.literal("archive"), from: z.string() }),
]);
export type FileMoveOutcome = z.infer<typeof FileMoveOutcomeSchema>;

export const FileMoveResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    /** The resolved destination folder. */
    destDir: z.string(),
    /** One outcome per source, aligned with the request's `sources`. */
    results: z.array(FileMoveOutcomeSchema),
  }),
  // The destination itself cannot take anything: no source was touched.
  Missing,
  Denied,
  NotADir,
  /**
   * The destination cannot take entries: inside an archive (or an archive
   * file's root), or a folder the system keeps itself.
   */
  z.object({ kind: z.literal("archive"), path: z.string() }),
]);
export type FileMoveResult = z.infer<typeof FileMoveResultSchema>;

const MoveBodySchema = z.object({
  sources: z.array(z.string()).min(1).max(FILE_MOVE_MAX_SOURCES),
  destDir: z.string(),
  resolutions: z.record(z.string(), FileMoveResolutionSchema).optional(),
});

/**
 * Move paths of the computer's disk into a folder, the way the Finder does:
 * each source keeps its name; a folder cannot go into itself or a
 * descendant; a source already in `destDir` is left alone. A taken name is
 * NOT overwritten unless asked: without a `resolutions` entry (keyed by source
 * path, as sent or as answered in `from`) it answers `exists` and the other
 * sources still move. Across volumes the source is copied then removed.
 * Archive members are refused on either side. Moving between two file systems
 * is not offered (a source is a path of the one system the endpoint is).
 */
export const computerFileMove = defineEndpoint({
  route: "POST /api/files/computer/move",
  body: MoveBodySchema,
  response: FileMoveResultSchema,
  needsMachine: COMPUTER,
});

/**
 * Move paths of the browser's storage into a folder — as
 * {@link computerFileMove}, in the browser's own tree. The apps' folders under
 * `~/.equin/` are the apps' to keep: a move of or into one is refused
 * (`archive`).
 */
export const browserFileMove = defineEndpoint({
  route: "POST /api/files/browser/move",
  body: MoveBodySchema,
  response: FileMoveResultSchema,
});
