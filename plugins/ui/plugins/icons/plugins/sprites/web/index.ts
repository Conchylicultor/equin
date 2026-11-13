import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { iconSpritesBootTask } from "./internal/boot";
import { IconSpriteHost } from "./internal/sprite-host";

export { ScopeIconSymbols } from "./internal/sprite-host";

export default {
  description:
    "Mounts the page's icon sprites inline. The resident default-style sprites and the saved-icon symbols the first paint needs are fetched by the SPA shell's head at t0 (content-addressed assets the browser caches) and provided by a Core.Boot task before the first render — never carried by the boot snapshot; every other sprite (another style a theme scope picks, the Seti and Lucide sprites, a resident one the head did not provide) and every other saved name are read live, on demand. ScopeIconSymbols gives a plugin scope (a demo) saved icons of its own, read from the scope's server and drawn in a sheet inside it.",
  contributions: [
    iconSpritesBootTask,
    Icons.Root({ component: IconSpriteHost, companion: true, scope: "page" }),
  ],
} satisfies PluginDefinition;
