import { defineRootSlot } from "@plugins/framework/plugins/web-sdk/core";

export const FontFamily = {
  // What a theme naming a font family needs on the page: the loader that fetches
  // the family. The token group only paints the `--font-*` vars, so without it a
  // theme's font never loads; the loader contributes here as a companion and
  // ships wherever this group does.
  Root: defineRootSlot(),
};
