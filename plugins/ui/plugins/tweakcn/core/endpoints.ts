import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SavedThemeWriteSchema } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/core";

/**
 * Import a theme from tweakcn.com by id: fetched live, converted, and saved as
 * a `tweakcn` saved theme. Importing the same id again updates that theme in
 * place (same id) rather than adding a second one. Answers the saved theme and
 * its commit's ack token (`useAwaitSavedThemesWrite`).
 */
export const importTweakcnTheme = defineEndpoint({
  route: "POST /api/tweakcn/themes",
  body: z.object({ themeId: z.string() }),
  response: SavedThemeWriteSchema,
});
