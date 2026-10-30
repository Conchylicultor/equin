import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Toggle a page's starred state. Server upserts the presence row when starring
// and deletes the side-table row when unstarring.
export const putPageStarred = defineEndpoint({
  route: "PUT /api/pages/:pageId/starred",
  body: z.object({ starred: z.boolean() }),
});
