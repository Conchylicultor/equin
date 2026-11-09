import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { FileLocationSchema } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// The read surface a generic browser (the file explorer's "App data" place)
// lists a file root through, on every host: the roots that opt in (`browse`
// on `defineFileRoot`), and each one's folders and entries — named by the
// root's id and a path relative to it. A file's contents are read where the
// root's folder IS (`BrowsableRoot.location`), through file-systems' reads.
// Served by this plugin's portable `server/`, pushed from the root's own watch.

/** One root a browser may show: its id, the words for it, and the data dir it is. */
export const BrowsableRootSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The data dir, `${kind}/${name}` (`apps/prototypes`). */
  dir: z.string(),
  /**
   * Where the root's folder is in this host's file system — what a reader
   * names its files by (file-systems' reads, the file viewer): the data dir on
   * the computer's disk, or under the browser storage's `~/.equin/`.
   */
  location: FileLocationSchema,
});
export type BrowsableRoot = z.infer<typeof BrowsableRootSchema>;

/**
 * Every file root declared `browse` in this process, in declaration order. The
 * set is code: it changes only with a build.
 */
export const dataFileRoots = liveValue("data-files.roots", {
  schema: wholeList(BrowsableRootSchema, {
    reason:
      "the file roots declared in code that opt in to browsing — a handful, fixed per build",
  }),
});

/** One entry of a root's folder — `FileEntry` as the wire carries it. */
export const DataFileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number(),
  mtimeMs: z.number(),
  birthtimeMs: z.number(),
});

/**
 * A folder of a root: `path` relative to it (`"_picks"`); absent is the root
 * itself. A path that is not a `RelPath` (`..`, a leading `/`) is refused
 * `invalid-path`.
 */
export const DataFolderQuerySchema = z.object({
  root: z.string(),
  path: z.string().optional(),
});

/** What a listing says about its folder beside the entries. */
export const DataFolderMetaSchema = z.object({
  root: z.string(),
  /** The folder, relative to the root (`""` for the root). */
  path: z.string(),
  /** How many entries it holds. */
  total: z.number(),
});
export type DataFolderMeta = z.infer<typeof DataFolderMetaSchema>;

// Why a read of a root cannot answer, as its refusal code:
//
// - `unknown-root` — no root of that id is declared `browse` on this host;
// - `invalid-path` — the path is not one inside a root (`..`, `/x`, NUL, …);
// - `missing` — nothing there;
// - `not-a-dir` — a file where a folder is listed.

/**
 * A root folder's entries, key-range-PAGED by name in code-point order (as
 * `host-fs.list`: a data dir grows with the user's data). The folder's facts
 * are the meta sibling, `dataFolderListing.meta`. Pushed while read from the
 * root's watch — so a change the root's `watch.extensions` filter drops (a
 * lock, a temp file) reaches it only with the next change that passes it, or a
 * dropped-events `rescan`.
 */
export const dataFolderListing = liveValue("data-files.list", {
  query: DataFolderQuerySchema,
  paged: {
    item: DataFileEntrySchema,
    id: "name",
    key: { of: (entry) => [entry.name], order: ["asc"] },
    limit: 500,
    maxLimit: 2000,
    meta: DataFolderMetaSchema,
  },
  refusals: ["unknown-root", "invalid-path", "missing", "not-a-dir"],
});

export const DataFileStatSchema = z.object({
  root: z.string(),
  path: z.string(),
  entry: DataFileEntrySchema,
});
export type DataFileStat = z.infer<typeof DataFileStatSchema>;

/** One path of a root described, pushed from the root's watch while read. */
export const dataFileStat = liveValue("data-files.stat", {
  schema: DataFileStatSchema,
  params: ["root", "path"],
  refusals: ["unknown-root", "invalid-path", "missing"],
});
