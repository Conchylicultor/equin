import { isSpriteKey } from "@plugins/ui/plugins/icons/core";
import { manifestHash, spriteFor } from "./sprites";

/**
 * `GET /api/icons/sprite/:hash/:key` — one sprite as `image/svg+xml`, for a
 * style no resident sprite covers (an app themed to rounded, say), or for a
 * sprite that is never resident (the Seti file-type glyphs).
 *
 * Content-addressed: `hash` must be this process's manifest hash (the one the
 * resident value carries), so the response is immutable for its URL. A stale
 * hash — a tab that outlived a restart with a different manifest — is refused
 * rather than answered with bytes the URL does not name.
 *
 * A raw handler rather than `implement()`: the blob codec carries only the
 * body, and this response needs its immutable cache header.
 */
export async function handleSprite(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const key = params.key;
  if (key === undefined || !isSpriteKey(key)) {
    return new Response(`unknown sprite: ${key}`, { status: 404 });
  }
  if (params.hash !== manifestHash) {
    return new Response(
      `sprite version ${params.hash} is not this server's (${manifestHash}); reload the page`,
      { status: 409 },
    );
  }
  return new Response(await spriteFor(key), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
