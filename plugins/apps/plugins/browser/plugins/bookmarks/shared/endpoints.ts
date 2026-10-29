import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow } from "@plugins/network/plugins/live/core";
import { browserBookmarksEntityRef } from "../core";

// Add a bookmark for a URL. The server generates the id and createdAt.
export const addBookmark = defineEndpoint({
  route: "POST /api/browser/bookmarks",
  body: z.object({ url: z.string(), title: z.string() }),
  unpredicted: {
    reason: "server-minted-id",
    why: "The server mints the bookmark's id and createdAt, and a window never gains a predicted entrant (its row key and counts are the server's), so no read could show the new row before the push.",
  },
});

// Remove a bookmark by id.
export const deleteBookmark = defineEndpoint({
  route: "DELETE /api/browser/bookmarks/:id",
  effect: (on) =>
    removeRow(on, browserBookmarksEntityRef, ({ params }) => params.id),
});
