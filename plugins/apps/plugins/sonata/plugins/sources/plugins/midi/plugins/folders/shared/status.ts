import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Whether one watched folder can be read, as the backend last found it.
 *
 * `path` is the folder as configured; `dir` is what songs imported from it are
 * keyed under — the real (symlink-resolved) path once it resolved, else the
 * configured one. Every state but `ok` is a folder the backend is NOT
 * importing from, and the library says so: none of them is ever skipped
 * silently.
 *
 * - `missing` — nothing at the path (ENOENT, or a component of it is a file):
 *   moved, renamed, or on a drive that is not connected.
 * - `not-a-folder` — the path is a file.
 * - `denied` — the OS refused (EPERM / EACCES): on macOS, equin has not been
 *   given access to the folder (Privacy & Security → Files & Folders).
 * - `unreadable` — any other error, with its code and message as the OS said
 *   them.
 */
export const FolderStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), path: z.string(), dir: z.string() }),
  z.object({ state: z.literal("missing"), path: z.string(), dir: z.string() }),
  z.object({
    state: z.literal("not-a-folder"),
    path: z.string(),
    dir: z.string(),
  }),
  z.object({
    state: z.literal("denied"),
    path: z.string(),
    dir: z.string(),
    code: z.enum(["EPERM", "EACCES"]),
  }),
  z.object({
    state: z.literal("unreadable"),
    path: z.string(),
    dir: z.string(),
    code: z.string(),
    message: z.string(),
  }),
]);
export type FolderStatus = z.infer<typeof FolderStatusSchema>;

const FolderStatusesSchema = wholeList(FolderStatusSchema, {
  reason: "one entry per configured watched folder — a handful, user-authored",
});

/**
 * Every configured folder's status, in config order — pushed whenever a
 * re-check finds a folder's state changed (a config edit, the reconcile, the
 * user's Check again).
 */
export const midiFoldersStatus = liveValue("sonata.midi-folders.status", {
  schema: FolderStatusesSchema,
});

/** How many folder-imported songs live under `dir` (any depth). */
export const midiFolderSongCount = liveValue("sonata.midi-folders.song-count", {
  schema: z.number().int().nonnegative(),
  params: ["dir"],
});

/**
 * Check every watched folder again now — macOS sends no signal when the user
 * grants access, so this is how a fixed folder is noticed (and then watched
 * and imported). Answers the statuses it found.
 */
export const recheckMidiFolders = defineEndpoint({
  route: "POST /api/sonata/midi-folders/recheck",
  response: FolderStatusesSchema,
});
