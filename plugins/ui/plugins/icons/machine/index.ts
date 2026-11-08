import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { symbolBody } from "./internal/resolve-icon";

export default {
  description:
    "Reads one Material Symbols glyph out of the icon sets installed on the computer: symbolBody (a glyph in a style, for a one-shot consumer with no sprite sheet — the release CLI's app icon; it parses both sets per call, so a running backend reads an app's glyph from the sprites' build instead: sprites/machine manifestSymbolBody).",
  contributions: [],
} satisfies MachinePluginDefinition;
