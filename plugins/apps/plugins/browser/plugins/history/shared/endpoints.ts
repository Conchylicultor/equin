import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Record a visit to a URL. The server derives the title from the URL hostname
// and stamps `visitedAt` server-side, then notifies the recents resource.
export const postBrowserHistory = defineEndpoint({
  route: "POST /api/browser/history",
  body: z.object({ url: z.string() }),
});
