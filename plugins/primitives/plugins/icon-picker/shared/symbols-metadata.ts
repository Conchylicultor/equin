import { createHash } from "crypto";
import { z } from "zod";

/**
 * The picker's browse/search data: Google's Material Symbols metadata (name →
 * category, tags, popularity), vendored as Google publishes it — a function of
 * Google's file alone, never of the installed `@iconify-json` sets. The loader
 * keeps the names the installed sets draw, so moving a set changes what the
 * picker shows with nothing to regenerate. Shared by the generator script
 * (which writes the file) and the `icon-picker:symbols-metadata-in-sync` check.
 */

export const SYMBOLS_METADATA_REL_PATH =
  "plugins/primitives/plugins/icon-picker/web/internal/symbols-metadata.json";

/** Where Google publishes it (the first line is the `)]}'` XSSI guard). */
export const SYMBOLS_METADATA_URL =
  "https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=true";

/** One icon: `[name, category index, space-joined lowercase tags]`. */
export const SymbolsMetadataSchema = z.object({
  contentHash: z.string(),
  categories: z.array(z.string()),
  icons: z.array(z.tuple([z.string(), z.number().int(), z.string()])),
});
export type SymbolsMetadata = z.infer<typeof SymbolsMetadataSchema>;

/** Hash of the data itself, so a hand edit of the vendored file is caught. */
export function symbolsMetadataContentHash(
  data: Pick<SymbolsMetadata, "categories" | "icons">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([data.categories, data.icons]))
    .digest("hex")
    .slice(0, 16);
}
