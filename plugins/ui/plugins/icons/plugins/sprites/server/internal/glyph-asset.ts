import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import type { GlyphKey } from "@plugins/ui/plugins/icons/core";
import { getGlyphAsset } from "../../core";
import { drawGlyphs, glyphTupleRefusal } from "./runtime-symbols-value";

/**
 * `GET /api/icons/glyph-assets/:hash/:key/:names` — one glyph batch as an
 * asset the browser caches for good: the path is its content's address (the
 * key's hash, the sorted names), so a change is a different URL, never a stale
 * hit. The shell's head fetches the batches the page's last first frame drew
 * (`head.ts`). The same answer and refusals as `icons.runtime-symbols`: a hash
 * that is not this host's is a 409 (the page's live reads re-key off the new
 * one), a malformed address a 400.
 */
export const handleGlyphAsset = rawEndpointHandler(
  getGlyphAsset,
  async (_req, params) => {
    const raw = params.names ?? "";
    const names = raw === "" ? [] : raw.split(",");
    const refusal = glyphTupleRefusal(
      params.hash ?? "",
      params.key ?? "",
      names,
    );
    if (refusal !== null) {
      return new Response(refusal.message, {
        status: refusal.code === "stale-symbols" ? 409 : 400,
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response(await drawGlyphs(params.key as GlyphKey, names), {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
);
