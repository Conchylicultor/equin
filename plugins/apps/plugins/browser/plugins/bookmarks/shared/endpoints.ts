import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Add a bookmark for a URL. The server generates the id and createdAt.
export const addBookmark = defineEndpoint({
  route: "POST /api/browser/bookmarks",
  body: z.object({ url: z.string(), title: z.string() }),
});

// Remove a bookmark by id.
export const deleteBookmark = defineEndpoint({
  route: "DELETE /api/browser/bookmarks/:id",
});
