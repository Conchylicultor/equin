#!/usr/bin/env bun
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
/**
 * Vendors Google's Material Symbols metadata (category, tags, popularity per
 * icon) into `web/internal/symbols-metadata.json` — the icon picker's browse
 * and search data (Iconify's own metadata has categories but no tags, and tags
 * carry search: "robot" → `smart-toy`). Every icon Google lists is kept: the
 * picker drops, as it loads, the names the installed sets do not draw, so an
 * `@iconify-json/material-symbols*` upgrade needs no rerun. Rerun it only to
 * pick up Google's newer metadata (new icons, tags, categories).
 *
 * Usage: ./equin run plugins/primitives/plugins/icon-picker/scripts/gen-symbols-metadata.ts
 */
import { z } from "zod";
import { writeGenerated } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  SYMBOLS_METADATA_REL_PATH,
  SYMBOLS_METADATA_URL,
  symbolsMetadataContentHash,
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
  .map((icon) => ({ ...icon, name: icon.name.replace(/_/g, "-") }));

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
  contentHash: symbolsMetadataContentHash({ categories, icons }),
  categories,
  icons,
};
await writeGenerated({
  file: joinAppPath(await getWorktreeRoot(), SYMBOLS_METADATA_REL_PATH),
  content: `${JSON.stringify(data)}\n`,
});
console.log(
  `Generated ${SYMBOLS_METADATA_REL_PATH} — ${icons.length} icons in ${categories.length} categories`,
);
