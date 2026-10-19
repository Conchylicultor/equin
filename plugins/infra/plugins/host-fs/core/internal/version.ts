import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * A file's on-disk revision: an opaque stamp that moves whenever its bytes
 * may have (inode, size, mtime of the entry holding them — the archive file,
 * for a member of one), `null` while nothing readable is there. It carries no
 * content: a reader holds it beside its own read of the file and re-reads when
 * it moves.
 */
export const FileVersionSchema = z.object({ stamp: z.string().nullable() });
export type FileVersion = z.infer<typeof FileVersionSchema>;

/**
 * The revision of the host file at `path` (absolute or `~`), pushed while
 * subscribed from a watch of the folder holding it — an edit, a replace by
 * rename, a delete and a re-create each move it. `invalid-path` refuses a path
 * no host-fs route would read (relative, or holding a NUL).
 */
export const hostFsVersion = liveValue("host-fs.version", {
  schema: FileVersionSchema,
  params: ["path"],
  refusals: ["invalid-path"],
  needsMachine: { feature: "Watching host files" },
});
