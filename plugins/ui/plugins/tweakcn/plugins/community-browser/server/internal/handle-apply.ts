import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { convertTweakcnTheme } from "@plugins/ui/plugins/tweakcn/core";
import { saveTheme } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/server";
import { applyCatalogTheme } from "../../core";
import { loadCatalog } from "./load-catalog";

export const handleApply = implement(applyCatalogTheme, async ({ body }) => {
  const { themeId } = body;
  const catalog = await loadCatalog();
  const theme = catalog.find((t) => t.id === themeId);
  if (!theme) {
    throw new HttpError(404, `Theme "${themeId}" not found in catalog`);
  }

  return saveTheme({
    source: "tweakcn",
    externalId: theme.id,
    label: theme.name,
    fragments: convertTweakcnTheme(theme.cssVars),
  });
});
