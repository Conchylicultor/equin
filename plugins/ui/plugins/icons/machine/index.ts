import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { symbolBody } from "./internal/resolve-icon";

export default {
  description:
    "Reads one Material Symbols glyph out of the icon sets installed on the computer: symbolBody (a glyph in a style, for a consumer with no sprite sheet — the release CLI's app icon, an installed app's icon PNG).",
  contributions: [],
} satisfies MachinePluginDefinition;
