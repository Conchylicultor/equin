/**
 * Writes every generated logo file (`LOGO_FILES`) from the geometry in core/:
 *
 *   ./equin run plugins/ui/plugins/logo/scripts/render.ts
 *
 * Run it after changing the logo; the `logo:files-in-sync` check fails until
 * you do. PNGs are rasterized with resvg and stamped with the digest of the
 * SVG they came from (a `tEXt` chunk), which is what the check compares.
 */
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  LOGO_FILES,
  LOGO_PNG_SOURCE_KEY,
  logoFileSvg,
  logoPngSourceDigest,
  withPngText,
} from "../core";

const root = await getWorktreeRoot();
for (const file of LOGO_FILES) {
  let bytes: string | Uint8Array;
  if (file.kind === "svg") {
    bytes = logoFileSvg(file.path);
  } else {
    // The logo draws no text, so no font is loaded (lint no-resvg-system-fonts).
    const png = new Resvg(logoFileSvg(file.from), {
      fitTo: { mode: "width", value: file.px },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    bytes = withPngText(
      new Uint8Array(png),
      LOGO_PNG_SOURCE_KEY,
      logoPngSourceDigest(file),
    );
  }
  writeFileSync(join(root, file.path), bytes);
  console.log(`wrote ${file.path}`);
}
