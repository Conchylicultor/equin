import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  LOGO_FILES,
  LOGO_PNG_SOURCE_KEY,
  logoFileSvg,
  hasPngText,
  logoPngSourceDigest,
} from "../core";

const HINT =
  "Run `./equin run plugins/ui/plugins/logo/scripts/render.ts` and commit the result.";

const filesInSync: Check = {
  id: "logo:files-in-sync",
  description:
    "Every generated logo file (favicons, the native helper's icons — ui/logo LOGO_FILES) matches the logo geometry in ui/logo/core",
  async run(ctx) {
    const repo = await ctx.repo();
    const stale: string[] = [];
    for (const file of LOGO_FILES) {
      const text = await repo.read(file.path);
      if (text === null) {
        stale.push(`${file.path} (missing)`);
      } else if (file.kind === "svg") {
        if (text !== logoFileSvg(file.path)) stale.push(file.path);
      } else if (
        !hasPngText(text, LOGO_PNG_SOURCE_KEY, logoPngSourceDigest(file))
      ) {
        // The digest covers the source SVG and the size, so a PNG rendered from
        // another logo, or at another size, does not carry it.
        stale.push(file.path);
      }
    }
    if (stale.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Out of sync with the logo geometry:\n${stale.map((p) => `  ${p}`).join("\n")}`,
      hint: HINT,
    };
  },
};

export default filesInSync;
