#!/usr/bin/env bun
/**
 * Vendors Google's Material Symbols metadata (category, tags, popularity per
 * icon) into `web/internal/symbols-metadata.json`, trimmed to the names the
 * installed sets draw — the icon picker's browse and search data (Iconify's
 * own metadata has categories but no tags, and tags carry search: "robot" →
 * `smart-toy`). Run it after upgrading an `@iconify-json/material-symbols*`
 * package; `icon-picker:symbols-metadata-in-sync` fails until you do.
 *
 * Usage: ./equin run plugins/primitives/plugins/icon-picker/scripts/gen-symbols-metadata.ts
 */
import { join } from "path";
import { z } from "zod";
import { writeGenerated } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  SYMBOLS_METADATA_REL_PATH,
  SYMBOLS_METADATA_URL,
  symbolsMetadataContentHash,
  symbolsMetadataInputsHash,
  type SymbolsMetadata,
} from "../shared/symbols-metadata";

const GoogleSchema = z.object({
  families: z.array(z.string()),
  icons: z.array(
    z.object({
      name: z.string(),
      popularity: z.number(),
      categories: z.array(z.string()),
      tags: z.array(z.string()),
      unsupported_families: z.array(z.string()),
    }),
  ),
});

const res = await fetch(SYMBOLS_METADATA_URL);
if (!res.ok) {
  throw new Error(`GET ${SYMBOLS_METADATA_URL} → ${res.status}`);
}
const text = await res.text();
const google = GoogleSchema.parse(JSON.parse(text.slice(text.indexOf("\n"))));
const symbolFamilies = google.families.filter((f) =>
  f.startsWith("Material Symbols"),
);

const kept = google.icons
  .filter((icon) =>
    symbolFamilies.some((f) => !icon.unsupported_families.includes(f)),
  )
  .map((icon) => ({ ...icon, name: icon.name.replace(/_/g, "-") }))
  .filter((icon) => isSavedSymbolName(icon.name));

const categoryOf = (icon: { categories: string[] }) =>
  icon.categories[0] ?? "Other";
const byName = new Map(kept.map((icon) => [icon.name, icon]));
const categories = [...new Set([...byName.values()].map(categoryOf))].sort();
const icons: SymbolsMetadata["icons"] = [...byName.values()]
  .sort(
    (a, b) =>
      categories.indexOf(categoryOf(a)) - categories.indexOf(categoryOf(b)) ||
      b.popularity - a.popularity ||
      a.name.localeCompare(b.name),
  )
  .map((icon) => [
    icon.name,
    categories.indexOf(categoryOf(icon)),
    [...new Set(icon.tags.map((t) => t.toLowerCase()))].join(" "),
  ]);

const data: SymbolsMetadata = {
  inputsHash: symbolsMetadataInputsHash(),
  contentHash: symbolsMetadataContentHash({ categories, icons }),
  categories,
  icons,
};
await writeGenerated({
  file: join(await getWorktreeRoot(), SYMBOLS_METADATA_REL_PATH),
  content: `${JSON.stringify(data)}\n`,
});
console.log(
  `Generated ${SYMBOLS_METADATA_REL_PATH} — ${icons.length} icons in ${categories.length} categories`,
);
