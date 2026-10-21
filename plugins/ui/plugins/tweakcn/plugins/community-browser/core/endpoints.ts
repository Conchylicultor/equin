import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { z } from "zod";
import { SavedThemeWriteSchema } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/core";

/**
 * Save one catalog theme as a `tweakcn` saved theme (idempotent: saving it again
 * updates the same theme), answering the saved theme and its commit's ack token
 * (`awaitSavedThemesWrite`). Selecting it is the caller's move.
 */
export const applyCatalogTheme = defineEndpoint({
  route: "POST /api/tweakcn/community/apply",
  body: z.object({ themeId: z.string() }),
  response: SavedThemeWriteSchema,
});
