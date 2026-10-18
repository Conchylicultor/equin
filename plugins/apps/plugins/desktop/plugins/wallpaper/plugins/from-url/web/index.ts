import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Wallpaper } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { UrlPanel } from "./components/url-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "From-URL wallpaper source: contributes the From URL tab to the desktop wallpaper picker, emitting a pasted image URL the picker imports (and the server validates) via the import-url endpoint.",
  contributions: [
    Wallpaper.Provider({
      id: "from-url",
      label: "From URL",
      icon: symbol("link"),
      Panel: UrlPanel,
    }),
  ],
} satisfies PluginDefinition;
