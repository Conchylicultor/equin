import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Wallpaper } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { OpenversePanel } from "./components/openverse-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Openverse wallpaper source: contributes the Openverse tab to the desktop wallpaper picker, reusing the shared search panel over the server-side `openverse` provider.",
  contributions: [
    Wallpaper.Provider({
      id: "openverse",
      label: "Openverse",
      icon: symbol("image-search"),
      Panel: OpenversePanel,
    }),
  ],
} satisfies PluginDefinition;
