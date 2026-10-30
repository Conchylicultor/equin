import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { saveTheme } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/server";
import { importTweakcnTheme } from "../../core";
import { convertTweakcnTheme } from "../../core";

export const handleImport = implement(importTweakcnTheme, async ({ body }) => {
  const { themeId } = body;

  // Fetch the theme JSON from tweakcn
  const url = `https://tweakcn.com/r/themes/${themeId}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new HttpError(
      502,
      `Failed to fetch tweakcn theme "${themeId}": ${res.status} ${res.statusText}`,
    );
  }

  const rawJson = (await res.json()) as Record<string, unknown>;

  // Validate shape
  const cssVars = rawJson.cssVars as
    | {
        theme?: Record<string, string>;
        light?: Record<string, string>;
        dark?: Record<string, string>;
      }
    | undefined;
  if (!cssVars?.light || !cssVars?.dark || !cssVars?.theme) {
    throw new HttpError(
      422,
      `tweakcn theme "${themeId}" is missing cssVars.theme, cssVars.light, or cssVars.dark`,
    );
  }

  const label =
    typeof rawJson.name === "string" && rawJson.name.length > 0
      ? rawJson.name
      : themeId;

  return saveTheme({
    source: "tweakcn",
    externalId: themeId,
    label,
    fragments: convertTweakcnTheme({
      theme: cssVars.theme,
      light: cssVars.light,
      dark: cssVars.dark,
    }),
  });
});
