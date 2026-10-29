import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import { BROWSER_RECENTS_LIMIT, browserRecents } from "./resources";
import { visitTitleFor } from "./visit-title";

// Record a visit to a URL. The server derives the title from the URL hostname
// and stamps `visitedAt` server-side, then notifies the recents resource.
export const postBrowserHistory = defineEndpoint({
  route: "POST /api/browser/history",
  body: z.object({ url: z.string() }),
  // The start page's Recent list: this url moves to the top (one row per
  // distinct url), the list stays capped. `visitedAt` is the server's clock, so
  // the shown instant is approximate; the write confirms by commit.
  effect: (on) =>
    patchValue(
      on,
      browserRecents,
      () => ({}),
      (recents, { body }) =>
        [
          {
            url: body.url,
            title: visitTitleFor(body.url),
            visitedAt: new Date(),
          },
          ...recents.filter((r) => r.url !== body.url),
        ].slice(0, BROWSER_RECENTS_LIMIT),
    ),
});
