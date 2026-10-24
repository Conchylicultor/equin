import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

/** Why one theme's lists are loaded whole. */
const THEME_VARS_REASON = "one tweakcn theme's CSS variables — tens of tokens";

export const CatalogThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: wholeList(z.string(), { reason: "one theme's tags — a handful" }),
  source: z.enum(["registry", "community"]),
  likeCount: z.number().optional(),
  author: z.string().optional(),
  cssVars: z.object({
    theme: wholeRecord(z.string(), { reason: THEME_VARS_REASON }),
    light: wholeRecord(z.string(), { reason: THEME_VARS_REASON }),
    dark: wholeRecord(z.string(), { reason: THEME_VARS_REASON }),
  }),
});

/**
 * The tweakcn community catalog: every registry (curated) and community theme
 * in the snapshot bundled as `shared/catalog.json`.
 *
 * The WHOLE catalog, not a window: the browse source's `useEntries` contract
 * (theme-engine's `ThemeSource`) hands the gallery every entry, which it
 * searches, filters by tag and lists itself. It is bounded by construction: a
 * snapshot taken at dev time by `scripts/fetch-catalog.ts` and shipped with the
 * code — 522 themes (~2.1 MB of JSON) today — never grown by user data; it
 * changes only when that script is re-run and the code redeployed.
 */
export const communityCatalog = liveValue("tweakcn.community-catalog", {
  schema: z.object({
    themes: wholeList(CatalogThemeSchema, {
      reason:
        "a snapshot bundled with the code (522 themes today), never grown by user data — and the gallery searches and filters every entry",
    }),
  }),
});
