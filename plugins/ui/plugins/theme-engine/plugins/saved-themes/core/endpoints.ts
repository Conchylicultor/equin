import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import {
  ColorAdjustmentSchema,
  TokenGroupFragmentsSchema,
} from "@plugins/ui/plugins/theme-engine/core";
import { SavedThemeWriteSchema, ThemeScopeRefSchema } from "./saved-theme";
import { applyFragmentEdit, FragmentEditSchema } from "./fragment-edit";
import { savedThemesList } from "./resource";

// The list is read live (`saved-themes.list`, core/resource.ts). An edit of an
// existing custom theme is a predicted write (the list reads it at once); the
// writes that mint a theme answer their commit's ack token, so a caller can
// wait for that list to have it (`useAwaitSavedThemesWrite`, web).

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
  unpredicted: {
    reason: "server-minted-id",
    why: "the server mints the id and the caller selects the new copy",
  },
  body: SaveThemeInputSchema,
  response: SavedThemeWriteSchema,
});

/** Edit one token group of a custom theme — see `FragmentEditSchema`. */
export const patchSavedThemeFragment = defineEndpoint({
  route: "PATCH /api/saved-themes/:id/fragment",
  // Only a custom theme is editable (the copy is made first, see
  // `useEditTheme`); the edit is the pure function the server applies.
  effect: (on) =>
    patchValue(
      on,
      savedThemesList,
      () => ({}),
      (themes, { params, body }) =>
        themes.map((t) =>
          t.id === params.id && t.source === "custom"
            ? { ...t, fragments: applyFragmentEdit(t.fragments, body) }
            : t,
        ),
    ),
  body: FragmentEditSchema,
  response: SavedThemeWriteSchema,
});

/** Set a custom theme's own color adjustment; `null` clears it, so the inherited one applies again. */
export const patchSavedThemeColorAdjust = defineEndpoint({
  route: "PATCH /api/saved-themes/:id/color-adjust",
  effect: (on) =>
    patchValue(
      on,
      savedThemesList,
      () => ({}),
      (themes, { params, body }) =>
        themes.map((t) => {
          if (t.id !== params.id || t.source !== "custom") return t;
          const { colorAdjust: _previous, ...rest } = t;
          return body.colorAdjust === null
            ? rest
            : { ...rest, colorAdjust: body.colorAdjust };
        }),
    ),
  body: z.object({ colorAdjust: ColorAdjustmentSchema.nullable() }),
  response: SavedThemeWriteSchema,
});

export const renameSavedTheme = defineEndpoint({
  route: "PATCH /api/saved-themes/:id",
  effect: (on) =>
    patchValue(
      on,
      savedThemesList,
      () => ({}),
      (themes, { params, body }) =>
        themes.map((t) =>
          t.id === params.id && t.source === "custom"
            ? { ...t, label: body.label }
            : t,
        ),
    ),
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
  unpredicted: {
    reason: "precondition",
    why: "409 SavedThemeInUse is handled in a dialog before the delete is retried with reassign",
  },
  agentReverted: true,
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
