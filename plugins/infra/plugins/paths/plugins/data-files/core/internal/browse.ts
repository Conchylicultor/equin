import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// The read surface a generic browser (the file explorer's "App data" place)
// reads a file root through, on every host: the roots that opt in
// (`browse` on `defineFileRoot`), and each one's folders, entries and files —
// named by the root's id and a path relative to it, never a host path.
// Served by this plugin's portable `server/`, pushed from the root's own watch.

/** One root a browser may show: its id, the words for it, and the data dir it is. */
export const BrowsableRootSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The data dir, `${kind}/${name}` (`apps/prototypes`). */
  dir: z.string(),
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
// - `not-a-dir` / `not-a-file` — the wrong kind of entry for the read;
// - `too-large` / `binary` — a file `text` will not decode.

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

/** The largest file `data-files.text` decodes (2 MiB, as `host-fs.text`). */
export const DATA_FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export const DataFileTextSchema = z.object({
  root: z.string(),
  path: z.string(),
  content: z.string(),
  /** Bytes read. */
  size: z.number(),
});
export type DataFileText = z.infer<typeof DataFileTextSchema>;

/**
 * A root's file as UTF-8 text, capped at {@link DATA_FILE_TEXT_MAX_BYTES} and
 * binary-sniffed (a NUL in the first 8 KB). On demand, invalidated while read
 * from the root's watch.
 */
export const dataFileText = liveValue("data-files.text", {
  schema: DataFileTextSchema,
  params: ["root", "path"],
  load: "on-demand",
  refusals: [
    "unknown-root",
    "invalid-path",
    "missing",
    "not-a-file",
    "too-large",
    "binary",
  ],
});

/**
 * `GET /api/data-files/:root/raw?path=` — a browsable root's file, its bytes
 * verbatim with a Content-Type by extension. 404 for an unknown root, nothing
 * there or a folder; 400 for a path that is not one inside a root.
 */
export const dataFilesRaw = defineEndpoint({
  route: "GET /api/data-files/:root/raw",
  query: z.object({ path: z.string() }),
  response: blob(),
});

/**
 * A root's file as an asset an element loads (`<img src>`, an iframe, a
 * download) — through `useAssetSrc` (`endpoints/web`), over the subtree's
 * transport.
 */
export function dataFileUrl(root: string, path: string): AssetPath {
  return assetPath(dataFilesRaw, { root }, { path });
}
