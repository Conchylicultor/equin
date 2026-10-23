import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { COVER_RENDER_VERSION } from "../../core";
import type { CoverStore } from "./cover-cache";

/** What a per-source cover route hands over for one request. */
export interface ScoreCoverRequest {
  /**
   * The version the URL asked for — the row's `sourcesChangedAt` as the card
   * that built the URL knew it.
   */
  version: string;
  /** The row's `sourcesChangedAt` now. */
  current: string;
  /**
   * A hash of the content the cover is drawn from (the source's bytes, or the
   * parsed score) — the cache key, with the renderer version.
   */
  contentHash: string;
  /** Draw the cover; called only on a cache miss, once however many ask. */
  render: () => Promise<string>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The cache key of a cover: its content and the code that drew it. */
export function coverCacheKey(contentHash: string): string {
  return sha256Hex(`${contentHash}|${COVER_RENDER_VERSION}`);
}

/**
 * Serve one cover from `store`, rendering it on a miss.
 *
 * Content-addressed: the file is named by {@link coverCacheKey}, so an edited
 * song (new content hash) or a bumped `COVER_RENDER_VERSION` addresses a new
 * file instead of a stale hit. Concurrent misses for one key share a single
 * render. A render or store failure rejects — the route answers 500 and it is
 * reported, never a blank image passed off as the cover.
 *
 * The URL is versioned by the row's `sourcesChangedAt`: when it names the
 * current version the response is `immutable` (the browser never asks again
 * for that URL; the next change makes a new URL). A stale URL still gets the
 * CURRENT cover, `no-store`, so an old card shows the right art without
 * pinning it under the old URL.
 */
export function createCoverServer(
  store: CoverStore,
): (req: ScoreCoverRequest) => Promise<Response> {
  const renders = createInflight();
  return async (req) => {
    const key = coverCacheKey(req.contentHash);
    const cached = await store.read(key);
    const svg = cached.hit
      ? cached.svg
      : await renders.run(key, async () => {
          const drawn = await req.render();
          await store.write(key, drawn);
          return drawn;
        });
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": req.version === req.current ? IMMUTABLE : "no-store",
      },
    });
  };
}
