import { fileRootCoverStore } from "./cover-cache";
import { scoreCoverFiles } from "./roots";
import { createCoverServer } from "./serve-cover";

/**
 * Serve a Sonata song cover from the `scoreCoverFiles` root — see
 * {@link createCoverServer}. Called by each source's own cover route, which
 * parses its content and renders through `core`.
 */
export const serveScoreCover = createCoverServer(
  fileRootCoverStore(scoreCoverFiles),
);
