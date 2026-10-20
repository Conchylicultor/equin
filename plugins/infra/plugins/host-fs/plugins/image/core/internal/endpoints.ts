import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// ── which files, which sizes ─────────────────────────────────────────────────

/**
 * The extensions this plugin resizes and measures (lower case, no dot): raster
 * formats a resized copy can stand in for. Not SVG (it scales by itself) and
 * not GIF (a copy would drop the animation).
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

/** Whether `name`'s extension is one this plugin resizes. */
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
 * The version of a host file a resized URL names: its modification time and
 * size, as a host-fs listing reports them. The URL changes whenever the file
 * does, so the response can be cached for good.
 */
export function resizedVersion(file: {
  mtimeMs: number;
  size: number;
}): string {
  return `${file.mtimeMs}-${file.size}`;
}

// ── resized ──────────────────────────────────────────────────────────────────

/**
 * A host image scaled so its long edge is `edge` (one of
 * {@link RESIZED_EDGES}), never enlarged, rotated upright by its EXIF
 * orientation: JPEG, or WebP when it has transparency. Served with the same
 * inert headers as `raw`, and cached for good when `v` is the file's current
 * {@link resizedVersion}. 404 missing, 403 denied, 400 for a directory or an
 * edge outside the set, 422 for an unreadable archive member, 415 when the
 * bytes cannot be decoded — the caller then shows the original. Build URLs
 * with {@link hostResizedUrl}.
 */
export const hostFsImageResized = defineEndpoint({
  route: "GET /api/host-fs/image/resized",
  query: z.object({ path: z.string(), edge: z.string(), v: z.string() }),
  response: blob(),
});

/**
 * The URL of the host image at `path` with a long edge of at least `px`
 * (snapped up to an edge in {@link RESIZED_EDGES}), for the file version
 * `file` (from its listing).
 */
export function hostResizedUrl(
  path: string,
  px: number,
  file: { mtimeMs: number; size: number },
): string {
  return `${hostFsImageResized.path}?${new URLSearchParams({
    path,
    edge: String(snapEdge(px)),
    v: resizedVersion(file),
  }).toString()}`;
}

// ── sizes ────────────────────────────────────────────────────────────────────

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
