import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  choose,
  removeRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import { starredPages } from "./resources";

// Toggle a page's starred state. Server upserts the presence row when starring
// and deletes the side-table row when unstarring.
export const putPageStarred = defineEndpoint({
  route: "PUT /api/pages/:pageId/starred",
  body: z.object({ starred: z.boolean() }),
  // Starring adds the page's presence row, unstarring deletes it. The row is an
  // extension shape's (`from: null`): the favorites collection is the target.
  effect: (on) =>
    choose(on, ({ body }) => (body.starred ? "star" : "unstar"), {
      star: upsertRow(
        on,
        starredPages,
        ({ params }) => params.pageId,
        (row, { params }) =>
          row ?? { blockId: params.pageId, createdAt: new Date() },
      ),
      unstar: removeRow(on, starredPages, ({ params }) => params.pageId),
    }),
});
