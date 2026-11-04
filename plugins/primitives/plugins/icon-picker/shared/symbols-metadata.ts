import { createHash } from "crypto";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { fileURLToPath } from "url";
import { z } from "zod";

/**
 * The picker's browse/search data: Google's Material Symbols metadata (name →
 * category, tags, popularity), vendored and trimmed to the names the installed
 * sets draw. Shared by the generator script (which writes the file) and the
 * `icon-picker:symbols-metadata-in-sync` check, so they agree on what it is a
 * function of.
 */

export const SYMBOLS_METADATA_REL_PATH =
  "plugins/primitives/plugins/icon-picker/web/internal/symbols-metadata.json";

/** Where Google publishes it (the first line is the `)]}'` XSSI guard). */
export const SYMBOLS_METADATA_URL =
  "https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=true";

// Bump when the derivation changes, so the check asks for a regeneration.
const GENERATOR_VERSION = "1";

const SETS = [
  "@iconify-json/material-symbols",
  "@iconify-json/material-symbols-light",
] as const;

/** One icon: `[name, category index, space-joined lowercase tags]`. */
export const SymbolsMetadataSchema = z.object({
  inputsHash: z.string(),
  contentHash: z.string(),
  categories: z.array(z.string()),
  icons: z.array(z.tuple([z.string(), z.number().int(), z.string()])),
});
export type SymbolsMetadata = z.infer<typeof SymbolsMetadataSchema>;

function installedVersion(pkg: string): string {
  const file = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string })
    .version;
}

/** The installed sets decide which names are kept: a set upgrade asks for a regeneration. */
export function symbolsMetadataInputsHash(): string {
  return createHash("sha256")
    .update(GENERATOR_VERSION)
    .update(SETS.map((p) => `${p}@${installedVersion(p)}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Hash of the data itself, so a hand edit of the vendored file is caught. */
export function symbolsMetadataContentHash(
  data: Pick<SymbolsMetadata, "categories" | "icons">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([data.categories, data.icons]))
    .digest("hex")
    .slice(0, 16);
}
