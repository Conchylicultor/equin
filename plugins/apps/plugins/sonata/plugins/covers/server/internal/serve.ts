import { scoreCoverCacheDir } from "../../data-dirs";
import { diskCoverStore } from "./cover-cache";
import { createCoverServer } from "./serve-cover";

/**
 * Serve a Sonata song cover from the host-global `cache/sonata-covers` dir —
 * see {@link createCoverServer}. Called by each source's own cover route,
 * which parses its content and renders through `core`.
 */
export const serveScoreCover = createCoverServer(
  diskCoverStore(scoreCoverCacheDir),
);
