import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { CommandPaletteRoot } from "./internal/command-palette-root";
import { CommandPalette } from "./slots";

export { CommandPalette, type CommandPaletteItem } from "./slots";

export default {
  description:
    "Cmd+K command palette primitive. Plugins contribute commands via CommandPalette.Item; the dialog renders them with fuzzy search and keyboard navigation.",
  contributions: [Core.Root({ component: CommandPaletteRoot, scope: "page" })],
  slots: CommandPalette,
} satisfies PluginDefinition;
