import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Wallpaper } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { BuiltinPanel } from "./components/builtin-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Built-in wallpaper source: contributes the Built-in tab to the desktop wallpaper picker, a grid of the bundled wallpapers (and the theme-following gradient); picking one writes its id to the wallpaper config with no server upload.",
  contributions: [
    Wallpaper.Provider({
      id: "builtin",
      label: "Built-in",
      icon: symbol("wallpaper"),
      Panel: BuiltinPanel,
    }),
  ],
} satisfies PluginDefinition;
