import { z } from "zod";
import { defineConfig } from "@plugins/config_v2/core";
import { objectField } from "@plugins/fields/plugins/object/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

/**
 * Attribution metadata for a chosen wallpaper image — the open-license credit
 * (CC-BY compliance) shown unobtrusively in a desktop corner. Every field is
 * optional: an uploaded image carries no attribution, a URL paste may carry only
 * a source link, an Openverse pick carries the full set.
 */
export const WallpaperAttributionSchema = z.object({
  creator: z.string().optional(),
  license: z.string().optional(),
  licenseUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
});
export type WallpaperAttribution = z.infer<typeof WallpaperAttributionSchema>;

/**
 * One search result from a provider (Openverse, …) rendered as a thumbnail in
 * the picker grid. `fullUrl` is what gets imported on click.
 */
export const WallpaperResultSchema = z.object({
  id: z.string(),
  thumbUrl: z.string(),
  fullUrl: z.string(),
  attribution: WallpaperAttributionSchema.optional(),
});
export type WallpaperResult = z.infer<typeof WallpaperResultSchema>;

/**
 * The save-endpoint response: the new cache-bust version + stored mime. The web
 * picker writes these (plus attribution) into `wallpaperConfig` afterwards — the
 * endpoints only persist image bytes, never config.
 */
export const SavedWallpaperSchema = z.object({
  version: z.number().int(),
  mime: z.string(),
});
export type SavedWallpaper = z.infer<typeof SavedWallpaperSchema>;

/**
 * The desktop wallpaper setting: a built-in (the default, Elarun), an uploaded /
 * imported image, or the theme-following gradient (`default`). GLOBAL (no `scope: "app"`): the floating desktop
 * renders against the global `:root` theme, so the wallpaper is a property of the
 * desktop itself — one setting shared across apps and worktrees. Holds only
 * metadata + attribution; the image bytes live in the machine-global wallpaper
 * store and are served same-origin at `GET /api/wallpaper/image`.
 */
export const wallpaperConfig = defineConfig({
  name: "wallpaper",
  fields: {
    state: objectField({
      label: "Desktop wallpaper",
      subFields: {
        kind: enumField({
          label: "Kind",
          options: ["default", "image", "builtin"],
          default: "builtin",
        }),
        // The built-in wallpaper (`kind: "builtin"`), by `BUILTIN_WALLPAPERS` id;
        // Elarun out of the box. Ignored for the other kinds.
        id: textField({ label: "Built-in wallpaper", default: "elarun" }),
        // Bumped on every save: doubles as cache-bust (the `?v=` query) and as an
        // image-presence stamp (a fresh default state keeps version at 0).
        version: intField({ label: "Version", default: 0 }),
        mime: textField({ label: "MIME type", default: "" }),
        attribution: objectField({
          label: "Attribution",
          subFields: {
            creator: textField({ label: "Creator" }),
            license: textField({ label: "License" }),
            licenseUrl: textField({ label: "License URL" }),
            sourceUrl: textField({ label: "Source URL" }),
            title: textField({ label: "Title" }),
          },
        }),
      },
    }),
  },
});
