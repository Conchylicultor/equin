import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  ColorAdjustmentSchema,
  TokenGroupFragmentsSchema,
} from "@plugins/ui/plugins/theme-engine/core";
import { SavedThemeWriteSchema, ThemeScopeRefSchema } from "./saved-theme";
import { FragmentEditSchema } from "./fragment-edit";

// The list is read live (`saved-themes.list`, shared/resources.ts); every write
// below answers its commit's ack token, so a caller can wait for that list to
// have it (`useAwaitSavedThemesWrite`, web).

const createFields = {
  label: z.string().min(1),
  /**
   * A saved theme's id (`tweakcn:…` / `custom:…`) must name an existing row;
   * a bare id names a code theme, which only the browser can see — so the
   * caller passes one it resolved from its live theme list.
   */
  extends: z.string().optional(),
  fragments: TokenGroupFragmentsSchema,
  colorAdjust: ColorAdjustmentSchema.optional(),
};

/**
 * What saving a theme takes. A `tweakcn` theme is keyed by its tweakcn id, so
 * importing it again updates the row in place (same id) instead of adding a
 * second one.
 */
export const SaveThemeInputSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("tweakcn"),
    externalId: z.string().min(1),
    ...createFields,
  }),
  z.object({ source: z.literal("custom"), ...createFields }),
]);
export type SaveThemeInput = z.infer<typeof SaveThemeInputSchema>;

export const createSavedTheme = defineEndpoint({
  route: "POST /api/saved-themes",
  body: SaveThemeInputSchema,
  response: SavedThemeWriteSchema,
});

/** Edit one token group of a custom theme — see `FragmentEditSchema`. */
export const patchSavedThemeFragment = defineEndpoint({
  route: "PATCH /api/saved-themes/:id/fragment",
  body: FragmentEditSchema,
  response: SavedThemeWriteSchema,
});

/** Set a custom theme's own color adjustment; `null` clears it, so the inherited one applies again. */
export const patchSavedThemeColorAdjust = defineEndpoint({
  route: "PATCH /api/saved-themes/:id/color-adjust",
  body: z.object({ colorAdjust: ColorAdjustmentSchema.nullable() }),
  response: SavedThemeWriteSchema,
});

export const renameSavedTheme = defineEndpoint({
  route: "PATCH /api/saved-themes/:id",
  body: z.object({ label: z.string().min(1) }),
  response: SavedThemeWriteSchema,
});

/**
 * Delete a saved theme. While any scope still selects it, answers 409 with a
 * `SavedThemeInUse` body — unless `reassign` is set, which first moves those
 * scopes to the Default theme. Themes that `extends` the deleted one keep their
 * look: its values are folded into them and they inherit from its parent.
 */
export const deleteSavedTheme = defineEndpoint({
  route: "DELETE /api/saved-themes/:id",
  query: z.object({
    reassign: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  }),
  response: z.object({
    reassigned: z.array(ThemeScopeRefSchema),
    watermark: z.string(),
  }),
});
