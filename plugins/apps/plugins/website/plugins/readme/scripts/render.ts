/**
 * Writes the repo README's images (`README_FILES`) into docs/readme/:
 *
 *   ./equin run plugins/apps/plugins/website/plugins/readme/scripts/render.ts
 *
 * Run it after changing what they draw (this plugin, the logo, the apps
 * catalog, the tile colours); the `readme:files-in-sync` check fails until you do.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { readIconSetSync } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";
import { README_FILES, readmeGlyphs } from "../core";

const root = await getWorktreeRoot();
const glyphs = readmeGlyphs(readIconSetSync);
for (const file of README_FILES) {
  const out = join(root, file.path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, file.render(glyphs));
  console.log(`wrote ${file.path}`);
}
