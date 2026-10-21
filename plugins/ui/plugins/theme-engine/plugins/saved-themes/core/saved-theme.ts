import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  ColorAdjustmentSchema,
  TokenGroupFragmentsSchema,
  type Theme,
  type ThemeId,
} from "@plugins/ui/plugins/theme-engine/core";

/** The two sources a saved theme can have. Code (`built-in`) themes are never rows. */
export const SavedThemeSourceSchema = z.enum(["tweakcn", "custom"]);
export type SavedThemeSource = z.infer<typeof SavedThemeSourceSchema>;

/**
 * The id a theme imported from an external catalog is saved under:
 * `<source>:<external id>`. Deterministic, so re-importing lands on the same row
 * and an importer can tell which catalog entries are already saved without
 * asking the server.
 */
export function importedThemeId(
  source: "tweakcn",
  externalId: string,
): ThemeId {
  return `${source}:${externalId}`;
}

/**
 * A saved theme on the wire: exactly a `Theme`, so the resident source hands
 * the list endpoint's rows to theme-engine as they are.
 */
export const SavedThemeSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: SavedThemeSourceSchema,
  extends: z.string().optional(),
  fragments: TokenGroupFragmentsSchema,
  colorAdjust: ColorAdjustmentSchema.optional(),
}) satisfies ZodParser<Theme>;
export type SavedTheme = z.infer<typeof SavedThemeSchema>;

/**
 * What a write to the saved themes answers: the theme as written, and the
 * write transaction's id (`currentTxId`, read inside it) — the ack token a
 * caller hands `awaitSavedThemesWrite` (web) to wait until the page's theme
 * list has re-read that commit. A caller that selects the theme it just saved
 * must wait, or the painter would paint a missing theme for a frame.
 */
export const SavedThemeWriteSchema = z.object({
  theme: SavedThemeSchema,
  watermark: z.string(),
});
export type SavedThemeWrite = z.infer<typeof SavedThemeWriteSchema>;

/**
 * A scope that selects a theme: the desktop (no `scopeId` — the base config
 * document) or one app (`scopeId: "app:<id>"`).
 */
export const ThemeScopeRefSchema = z.object({ scopeId: z.string().optional() });
export type ThemeScopeRef = z.infer<typeof ThemeScopeRefSchema>;

/**
 * The body of the 409 a delete answers when scopes still select the theme.
 * `message` is what the global error toast shows; `usedBy` is what a caller
 * offering "delete anyway" names before retrying with `reassign`.
 */
export const SavedThemeInUseSchema = z.object({
  message: z.string(),
  usedBy: z.array(ThemeScopeRefSchema),
});
export type SavedThemeInUse = z.infer<typeof SavedThemeInUseSchema>;
