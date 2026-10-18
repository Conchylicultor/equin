import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Wallpaper } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { UploadPanel } from "./components/upload-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Upload wallpaper source: contributes the Upload tab to the desktop wallpaper picker, emitting a local image file the picker funnels through the upload endpoint.",
  contributions: [
    Wallpaper.Provider({
      id: "upload",
      label: "Upload",
      icon: symbol("upload"),
      Panel: UploadPanel,
    }),
  ],
} satisfies PluginDefinition;
