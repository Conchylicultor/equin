import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { FILE_PEEK_MAX_NAMES, FileListingQuerySchema } from "./folders";

// Images made cheap to show — a folder of camera photos is dozens of
// 30-megapixel JPEGs, and drawing each one's original for a thumbnail
// downloads and decodes 7 MB per tile. A system whose capabilities say
// `images` serves smaller copies and the true pixel sizes; only the
// computer's disk does (host-fs's `image` sub-plugin), so these are declared
// only for it, as its completions and volume are. A viewer offers a copy
// only where `FILE_SYSTEMS[fs].capabilities.images` says so, and keeps the
// original elsewhere.

/** What the computer's disk needs — the same words as its file reads. */
const COMPUTER = { feature: "Browsing this computer's files" } as const;

// ── which files, which sizes ─────────────────────────────────────────────────

/**
 * The extensions a resized copy is made of and a size is measured for (lower
 * case, no dot): raster formats a copy can stand in for. Not SVG (it scales by
 * itself) and not GIF (a copy would drop the animation).
 */
export const RESIZABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "avif",
  "tif",
  "tiff",
]);

/** Whether `name`'s extension is one a resized copy is made of. */
export function isResizableName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && RESIZABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The long edges, in px, a resized copy comes in. A closed set, so the cache
 * holds at most this many copies of one file.
 */
export const RESIZED_EDGES = [160, 320, 640, 1280, 2560] as const;
export type ResizedEdge = (typeof RESIZED_EDGES)[number];

/** The smallest edge at least `px` long — the largest when none is. */
export function snapEdge(px: number): ResizedEdge {
  for (const edge of RESIZED_EDGES) if (edge >= px) return edge;
  return RESIZED_EDGES[4];
}

/** `edge` as one of {@link RESIZED_EDGES}, or `null` when it is not one. */
export function parseEdge(raw: string): ResizedEdge | null {
  return RESIZED_EDGES.find((e) => String(e) === raw) ?? null;
}

/**
 * The version of a file a resized URL names: its modification time and size,
 * as its folder's listing reports them. The URL changes whenever the file
 * does, so the response can be cached for good.
 */
export function resizedVersion(file: {
  mtimeMs: number;
  size: number;
}): string {
  return `${file.mtimeMs}-${file.size}`;
}

// ── resized (the computer's disk) ────────────────────────────────────────────

/**
 * An image on the computer's disk scaled so its long edge is `edge` (one of
 * {@link RESIZED_EDGES}), never enlarged, rotated upright by its EXIF
 * orientation: JPEG, or WebP when it has transparency. Served with the same
 * inert headers as `raw`, and cached for good when `v` is the file's current
 * {@link resizedVersion}. 404 missing, 403 denied, 400 for a directory or an
 * edge outside the set, 422 for an unreadable archive member, 415 when the
 * bytes cannot be decoded — the caller then shows the original. Build its
 * asset with {@link computerResizedAsset}.
 */
export const computerImageResized = defineEndpoint({
  route: "GET /api/files/computer/image/resized",
  query: z.object({ path: z.string(), edge: z.string(), v: z.string() }),
  response: blob(),
  needsMachine: COMPUTER,
});

/**
 * The asset of the image at `path` on the computer's disk with a long edge of
 * at least `px` (snapped up to an edge in {@link RESIZED_EDGES}), for the
 * file version `file` (from its listing). A sink loading it by URL gets the
 * URL from `assetUrlOver` (`endpoints/web`).
 */
export function computerResizedAsset(
  path: string,
  px: number,
  file: { mtimeMs: number; size: number },
): AssetPath {
  return assetPath(
    computerImageResized,
    {},
    {
      path,
      edge: String(snapEdge(px)),
      v: resizedVersion(file),
    },
  );
}

// ── sizes (the computer's disk) ──────────────────────────────────────────────

/** An image's pixel size as it is shown: EXIF-rotated, so a portrait reads tall. */
export const ImageSizeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("known"),
    width: z.number(),
    height: z.number(),
  }),
  /** The header could not be decoded (corrupt, or a format the decoder lacks). */
  z.object({ kind: z.literal("unreadable") }),
]);
export type ImageSize = z.infer<typeof ImageSizeSchema>;

/** One resizable image of a folder and its upright pixel size. */
export const FolderImageSizeSchema = z.object({
  name: z.string(),
  size: ImageSizeSchema,
});
export type FolderImageSize = z.infer<typeof FolderImageSizeSchema>;

/**
 * The upright pixel size of every resizable image (`isResizableName`) in a
 * folder of the computer's disk, read from the headers only — key-range-PAGED
 * (a folder grows with the user's data), by name in code-point order, over
 * the same question as the folder's listing (`{ path }`), so a reader asks
 * both of one folder alike. Only the images of the pages read are measured.
 * Pushed while read from a watch of the folder. Refused: `invalid-path`,
 * `missing`, `denied`, `not-a-dir`, `unreadable-archive`.
 */
export const computerImageSizes = liveValue("files.computer.image-sizes", {
  query: FileListingQuerySchema,
  paged: {
    item: FolderImageSizeSchema,
    id: "name",
    key: { of: (image) => [image.name], order: ["asc"] },
    limit: 200,
    // As many as the folder's listing holds of one folder.
    maxLimit: FILE_PEEK_MAX_NAMES,
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
