import type { ThumbnailRendererImpl } from "../../server/internal/renderer";
import { renderThumbnailJob } from "./jobs";

/**
 * The desktop's renderer: headless Chromium (Playwright), one render at a time
 * through the `prototypes.render-thumbnail` job, which records each outcome on
 * the card itself.
 */
export const chromiumThumbnails: ThumbnailRendererImpl = {
  kind: "renders",
  request: async (item) => {
    await renderThumbnailJob.enqueue(item);
  },
};
