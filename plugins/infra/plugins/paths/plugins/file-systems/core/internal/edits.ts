import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { FILE_TEXT_MAX_BYTES } from "./reads";

// The edits a file browser makes to a browsable file system — create an
// entry, rename one, delete some, save a text file — declared once per
// system, as the move is (`./folders.ts`): each system's half serves its own,
// and a browser offers them only where `FILE_SYSTEMS[fs].capabilities.edit`
// says the system has them. Moving to the Trash is the computer's alone
// (`capabilities.trash`): only its declaration exists.
//
// Every path is the system's own spelling (absolute, or `~`-rooted); every
// answer names the resolved path. Refusals are results, never errors: an
// entry that vanished, a folder the user may not write, a member of an
// archive (or, in the browser's storage, a folder an app keeps) — the same
// `missing` / `denied` / `archive` a move answers.

/** What the computer's disk needs — the same words as its file reads. */
const COMPUTER = { feature: "Browsing this computer's files" } as const;

/**
 * Whether `name` can name an entry of a folder: not empty, not `.` / `..`,
 * no `/` and no NUL. The one test both the browser (before asking) and every
 * system's half (on the request) apply.
 */
export function isValidEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

const Missing = z.object({ kind: z.literal("missing"), path: z.string() });
const Denied = z.object({ kind: z.literal("denied"), path: z.string() });
/**
 * The entry cannot be changed where it is: inside an archive, or a folder the
 * system keeps itself (an app's folder in the browser's storage).
 */
const Kept = z.object({ kind: z.literal("archive"), path: z.string() });
const InvalidName = z.object({
  kind: z.literal("invalid-name"),
  name: z.string(),
});

// ── create ───────────────────────────────────────────────────────────────────

export const FileCreateResultSchema = z.discriminatedUnion("kind", [
  /** `path`: the new entry — `name`, or the Finder's next free spelling of it. */
  z.object({ kind: z.literal("created"), path: z.string() }),
  Missing,
  Denied,
  z.object({ kind: z.literal("not-a-dir"), path: z.string() }),
  Kept,
  InvalidName,
]);
export type FileCreateResult = z.infer<typeof FileCreateResultSchema>;

const CreateBodySchema = z.object({
  /** The folder to create in. */
  dir: z.string(),
  /** The name wanted; a taken one gets a number (`untitled 2.txt`). */
  name: z.string(),
  /** An empty file, or an empty folder. */
  kind: z.enum(["file", "dir"]),
});

/**
 * Create an empty file or folder in a folder of the computer's disk, the
 * Finder's way: a taken name is never overwritten — the next free spelling
 * (`untitled folder 2`, `untitled 2.txt`) is used, and answered.
 */
export const computerFileCreate = defineEndpoint({
  route: "POST /api/files/computer/create",
  body: CreateBodySchema,
  response: FileCreateResultSchema,
  needsMachine: COMPUTER,
});

/** {@link computerFileCreate} in the browser's storage (never under `~/.equin/`). */
export const browserFileCreate = defineEndpoint({
  route: "POST /api/files/browser/create",
  body: CreateBodySchema,
  response: FileCreateResultSchema,
});

// ── rename ───────────────────────────────────────────────────────────────────

export const FileRenameResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("renamed"), from: z.string(), to: z.string() }),
  /** Another entry already has the name: nothing was renamed. */
  z.object({ kind: z.literal("exists"), from: z.string(), to: z.string() }),
  Missing,
  Denied,
  Kept,
  InvalidName,
]);
export type FileRenameResult = z.infer<typeof FileRenameResultSchema>;

const RenameBodySchema = z.object({
  path: z.string(),
  /** The new name, in the same folder. */
  name: z.string(),
});

/**
 * Rename an entry of the computer's disk in place. Never replaces: a name
 * another entry has answers `exists` (a change of case only is a rename of
 * the same entry, and goes through).
 */
export const computerFileRename = defineEndpoint({
  route: "POST /api/files/computer/rename",
  body: RenameBodySchema,
  response: FileRenameResultSchema,
  needsMachine: COMPUTER,
});

/** {@link computerFileRename} in the browser's storage. */
export const browserFileRename = defineEndpoint({
  route: "POST /api/files/browser/rename",
  body: RenameBodySchema,
  response: FileRenameResultSchema,
});

// ── delete / trash ───────────────────────────────────────────────────────────

/** How many entries one delete (or trash) takes at most. */
export const FILE_DELETE_MAX_PATHS = 1000;

/** What happened to one entry of a delete or a trash. `path` as resolved. */
export const FileRemoveOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("removed"), path: z.string() }),
  Missing,
  Denied,
  Kept,
]);
export type FileRemoveOutcome = z.infer<typeof FileRemoveOutcomeSchema>;

export const FileRemoveResultSchema = z.object({
  /** One outcome per path, aligned with the request's `paths`. */
  results: z.array(FileRemoveOutcomeSchema),
});
export type FileRemoveResult = z.infer<typeof FileRemoveResultSchema>;

const RemoveBodySchema = z.object({
  paths: z.array(z.string()).min(1).max(FILE_DELETE_MAX_PATHS),
});

/**
 * Delete entries of the computer's disk for good — a folder with everything
 * in it. Not the Trash ({@link computerFileTrash}): nothing to put back.
 */
export const computerFileDelete = defineEndpoint({
  route: "POST /api/files/computer/delete",
  body: RemoveBodySchema,
  response: FileRemoveResultSchema,
  needsMachine: COMPUTER,
});

/** {@link computerFileDelete} in the browser's storage. */
export const browserFileDelete = defineEndpoint({
  route: "POST /api/files/browser/delete",
  body: RemoveBodySchema,
  response: FileRemoveResultSchema,
});

/**
 * Move entries of the computer's disk to the Trash, the way the Finder does
 * (Put Back works). macOS only (501 elsewhere).
 */
export const computerFileTrash = defineEndpoint({
  route: "POST /api/files/computer/trash",
  body: RemoveBodySchema,
  response: FileRemoveResultSchema,
  needsMachine: COMPUTER,
});

// ── write text ───────────────────────────────────────────────────────────────

export const FileWriteResultSchema = z.discriminatedUnion("kind", [
  /** `size`: the bytes written. */
  z.object({ kind: z.literal("written"), path: z.string(), size: z.number() }),
  /**
   * The file no longer holds the `expected` text — changed since the edit
   * began: nothing was written.
   */
  z.object({ kind: z.literal("changed"), path: z.string() }),
  Missing,
  Denied,
  z.object({ kind: z.literal("not-a-file"), path: z.string() }),
  Kept,
]);
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;

const WriteBodySchema = z.object({
  /** An existing file. */
  path: z.string(),
  text: z.string().max(FILE_TEXT_MAX_BYTES),
  /**
   * The text the edit started from: the write goes through only while the
   * file still holds it (else `changed`). Absent: overwrite whatever is there.
   */
  expected: z.string().max(FILE_TEXT_MAX_BYTES).optional(),
});

/**
 * Save text into an existing file of the computer's disk, as UTF-8 —
 * atomically (a reader sees the old bytes or the new ones), keeping its
 * permissions.
 */
export const computerFileWrite = defineEndpoint({
  route: "POST /api/files/computer/write",
  body: WriteBodySchema,
  response: FileWriteResultSchema,
  needsMachine: COMPUTER,
});

/** {@link computerFileWrite} in the browser's storage. */
export const browserFileWrite = defineEndpoint({
  route: "POST /api/files/browser/write",
  body: WriteBodySchema,
  response: FileWriteResultSchema,
});
