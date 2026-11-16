import type { Check } from "@plugins/framework/plugins/tooling/core";
import { readIconSetSync } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";
import { README_FILES, glyphsFrom } from "../core";

const filesInSync: Check = {
  id: "readme:files-in-sync",
  description:
    "Every image the repo README shows (docs/readme/ — apps/website/readme README_FILES) matches what its renderer draws now from the logo, the apps catalog and the tile colours",
  async run(ctx) {
    const repo = await ctx.repo();
    const glyph = glyphsFrom(readIconSetSync("@iconify-json/material-symbols"));
    const stale: string[] = [];
    for (const file of README_FILES) {
      const text = await repo.read(file.path);
      if (text === null) stale.push(`${file.path} (missing)`);
      else if (text !== file.render(glyph)) stale.push(file.path);
    }
    if (stale.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Out of sync with what the README's renderer draws:\n${stale.map((p) => `  ${p}`).join("\n")}`,
      hint: "Run `./equin run plugins/apps/plugins/website/plugins/readme/scripts/render.ts` and commit the result.",
    };
  },
};

export default filesInSync;
