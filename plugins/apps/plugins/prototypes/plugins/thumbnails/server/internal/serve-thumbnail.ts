import { readThumbnail } from "./cache";

/** `<64 hex chars>.png` — the only shape this route serves. */
const KEY_PATTERN = /^([0-9a-f]{64})\.png$/;

/**
 * `GET /api/prototype-thumbs/:key` — one cached thumbnail, read through the
 * `thumbnailCache` root, so it answers on every host (a browser host serves
 * the PNGs its seed wrote).
 *
 * `immutable` is honest here rather than optimistic: the path IS the content
 * fingerprint, so an edited prototype produces a different URL instead of a
 * stale hit, and the browser never needs to revalidate. (Contrast the raw
 * prototype files, which are served `no-store` precisely because their URLs do
 * not change when they do.)
 */
export async function handleThumbnail(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const match = KEY_PATTERN.exec(params.key ?? "");
  if (!match) return new Response("invalid key", { status: 400 });

  const read = await readThumbnail(match[1]!);
  if (read.kind === "missing") {
    return new Response("not found", { status: 404 });
  }

  return new Response(read.blob, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
